import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { AppEvent } from "../events";
import { killGroup, spawnGroup } from "../process-group";
import { parseClaudeLine } from "./claude-parser";
import type { EmitFn, SteerFn } from "./types";

/**
 * Un process `claude` par CONVERSATION, au lieu d'un par tour.
 *
 * En mode `-p --input-format stream-json`, le CLI encaisse plusieurs tours sur
 * la même session tant que stdin reste ouvert. Le fermer à chaque tour, comme
 * le fait `spawnJsonl`, oblige à repayer le démarrage de toute la flotte MCP :
 * mesuré à 4,4 s contre 1,8 s avec seulement deux serveurs, et un projet en
 * déclare une douzaine.
 */

const DEFAULT_IDLE_MS = 5 * 60_000;

function idleMs(): number {
  const raw = Number(process.env.PUPITRE_CLAUDE_IDLE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_IDLE_MS;
}

/** Échappatoire : `0` rétablit un process par tour. */
export function persistenceEnabled(): boolean {
  return process.env.PUPITRE_CLAUDE_PERSISTENT !== "0";
}

export interface ClaudeTurnRequest {
  bin: string;
  /** Sans `-r` : la reprise ne concerne que le démarrage d'un process neuf. */
  args: string[];
  cwd: string;
  cliSessionId: string | null;
  /** Ligne JSONL du message utilisateur. */
  line: string;
  /** Rend la ligne JSONL d'une précision envoyée en cours de tour. */
  steerLine: (prompt: string, images: string[]) => string;
  emit: EmitFn;
  signal?: AbortSignal;
  registerSteer?: (steer: SteerFn) => void;
}

interface ActiveTurn {
  emit: EmitFn;
  resolve: () => void;
  settled: boolean;
  detachAbort: () => void;
}

/** Ce qui ne peut pas changer sans relancer le process. */
function shapeOf(request: ClaudeTurnRequest): string {
  return JSON.stringify([request.bin, request.cwd, request.args]);
}

class ClaudeSession {
  /** Connu dès l'événement `system/init` du premier tour. */
  cliSessionId: string | null = null;
  private turn: ActiveTurn | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private stderr = "";
  private closed = false;

  constructor(
    readonly shape: string,
    private readonly child: ChildProcess,
    private readonly onGone: (session: ClaudeSession) => void,
  ) {
    createInterface({ input: child.stdout! })
      .on("line", (line) => this.handleLine(line));
    child.stderr?.on("data", (chunk) => {
      this.stderr = (this.stderr + String(chunk)).slice(-4_000);
    });
    child.on("error", (error) => this.handleGone(String(error)));
    child.on("close", (code) => this.handleGone(
      this.stderr.trim() || `exit ${code}`,
    ));
    // stdin peut casser avant que `close` n'arrive ; le statut terminal
    // viendra de `handleGone`.
    child.stdin?.on("error", () => {});
  }

  get alive(): boolean {
    return !this.closed;
  }

  private handleLine(line: string): void {
    let events: AppEvent[];
    try {
      events = parseClaudeLine(line);
    } catch (error) {
      console.error("Impossible de parser une ligne JSONL, ligne ignorée", error);
      return;
    }
    for (const event of events) {
      if (event.type === "session") this.cliSessionId = event.cliSessionId;
      this.turn?.emit(event);
      if (event.type === "status") this.settle();
    }
  }

  private handleGone(detail: string): void {
    if (this.closed) return;
    this.closed = true;
    const turn = this.turn;
    if (turn && !turn.settled) {
      turn.emit({ type: "status", state: "error", error: detail });
    }
    this.settle();
    this.clearIdle();
    this.onGone(this);
  }

  /** Clôt le tour courant sans toucher au process : il resservira. */
  private settle(): void {
    const turn = this.turn;
    if (!turn || turn.settled) return;
    turn.settled = true;
    turn.detachAbort();
    this.turn = null;
    if (!this.closed) this.armIdle();
    turn.resolve();
  }

  private armIdle(): void {
    this.clearIdle();
    const timer = setTimeout(() => this.destroy(), idleMs());
    timer.unref?.();
    this.idleTimer = timer;
  }

  private clearIdle(): void {
    if (this.idleTimer === null) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  destroy(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearIdle();
    killGroup(this.child, "SIGTERM");
    const forceKill = setTimeout(() => killGroup(this.child, "SIGKILL"), 3_000);
    forceKill.unref?.();
    this.onGone(this);
  }

  run(request: ClaudeTurnRequest): Promise<void> {
    return new Promise((resolve) => {
      this.clearIdle();
      request.emit({ type: "status", state: "running" });

      if (request.signal?.aborted || this.closed) {
        request.emit({ type: "status", state: "error", error: "annulé" });
        this.destroy();
        resolve();
        return;
      }

      const onAbort = () => {
        const turn = this.turn;
        if (turn && !turn.settled) {
          turn.settled = true;
          this.turn = null;
          turn.emit({ type: "status", state: "error", error: "annulé" });
          // Annuler tue le process : le protocole n'offre pas d'interruption
          // en cours de tour, et un tour à moitié lu polluerait le suivant.
          this.destroy();
          turn.resolve();
        }
      };
      request.signal?.addEventListener("abort", onAbort, { once: true });

      this.turn = {
        emit: request.emit,
        resolve,
        settled: false,
        detachAbort: () => request.signal?.removeEventListener("abort", onAbort),
      };

      request.registerSteer?.(async (input) => {
        const turn = this.turn;
        if (!turn || turn.settled || this.closed) return false;
        return this.write(request.steerLine(input.prompt, input.images));
      });

      // Un binaire introuvable rend stdin inutilisable avant que l'événement
      // `error` n'arrive. C'est lui qui porte la cause exploitable (ENOENT et
      // le nom du binaire) ; l'échec d'écriture ne dirait que son symptôme.
      this.write(request.line);
    });
  }

  private write(line: string): boolean {
    const stdin = this.child.stdin;
    if (!stdin || stdin.destroyed) return false;
    return stdin.write(line + "\n") || true;
  }
}

class ClaudeSessionPool {
  private byCliSession = new Map<string, ClaudeSession>();
  /** Session dont l'id n'est pas encore connu : le premier tour est en cours. */
  private pendingId = new Set<ClaudeSession>();

  async runTurn(request: ClaudeTurnRequest): Promise<void> {
    const session = this.acquire(request);
    try {
      await session.run(request);
    } finally {
      this.index(session);
    }
  }

  private acquire(request: ClaudeTurnRequest): ClaudeSession {
    const shape = shapeOf(request);
    const id = request.cliSessionId;
    const reusable = id === null ? undefined : this.byCliSession.get(id);
    if (reusable?.alive && reusable.shape === shape) return reusable;
    // Modèle, mode de permission ou sélection MCP changés : le process en
    // place porte les anciens et ne peut pas les rejouer.
    if (reusable) reusable.destroy();

    const args = id === null ? request.args : [...request.args, "-r", id];
    const child = spawnGroup(request.bin, args, {
      cwd: request.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const session = new ClaudeSession(shape, child, (gone) => this.forget(gone));
    this.pendingId.add(session);
    return session;
  }

  private index(session: ClaudeSession): void {
    this.pendingId.delete(session);
    const id = session.cliSessionId;
    if (id === null) return;
    if (session.alive) this.byCliSession.set(id, session);
    else this.byCliSession.delete(id);
  }

  private forget(session: ClaudeSession): void {
    this.pendingId.delete(session);
    const id = session.cliSessionId;
    if (id !== null && this.byCliSession.get(id) === session) {
      this.byCliSession.delete(id);
    }
  }

  /** Arrêt du sidecar : sans ça les process persistants deviennent la fuite. */
  shutdown(): void {
    for (const session of [...this.byCliSession.values(), ...this.pendingId]) {
      session.destroy();
    }
    this.byCliSession.clear();
    this.pendingId.clear();
  }

  /** Nombre de process vivants, pour les tests et le diagnostic. */
  size(): number {
    return this.byCliSession.size + this.pendingId.size;
  }
}

export const claudeSessions = new ClaudeSessionPool();
