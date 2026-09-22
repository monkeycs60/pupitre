import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { AppEvent } from "../events";
import { killGroup, spawnGroup } from "../process-group";
import { createClaudeLineParser } from "./claude-parser";
import type { EmitFn, OpenAutonomousTurn, SteerFn } from "./types";

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
const DEFAULT_BACKGROUND_MAX_MS = 4 * 60 * 60_000;

function idleMs(): number {
  const raw = Number(process.env.PUPITRE_CLAUDE_IDLE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_IDLE_MS;
}

/**
 * Durée maximale d'inactivité tolérée tant que des tâches de fond tournent.
 * Tuer le process tue aussi ces tâches, lancées dans son groupe.
 */
function backgroundMaxMs(): number {
  const raw = Number(process.env.PUPITRE_CLAUDE_BACKGROUND_MAX_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BACKGROUND_MAX_MS;
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
  openAutonomousTurn?: OpenAutonomousTurn;
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
  /** Tour ouvert par le CLI lui-même, sans message de l'utilisateur. */
  private autonomous: EmitFn | null = null;
  /** Dernier tour reçu : il fournit de quoi ouvrir un tour autonome. */
  private lastRequest: ClaudeTurnRequest | null = null;
  private backgroundTasks = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private idleSince: number | null = null;
  private stderr = "";
  private closed = false;
  private readonly parseLine = createClaudeLineParser("claude", {
    onBackgroundTasks: (count) => {
      this.backgroundTasks = count;
      if (count === 0 && this.idle) this.armIdle();
    },
  });

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

  private get idle(): boolean {
    return this.turn === null && this.autonomous === null && !this.closed;
  }

  private handleLine(line: string): void {
    let events: AppEvent[];
    try {
      events = this.parseLine(line);
    } catch (error) {
      console.error("Impossible de parser une ligne JSONL, ligne ignorée", error);
      return;
    }
    for (const event of events) {
      if (event.type === "session") this.cliSessionId = event.cliSessionId;
      const emit = this.turn?.emit ?? this.autonomous ?? this.openAutonomous(event);
      emit?.(event);
      if (event.type !== "status") continue;
      if (this.turn) this.settle();
      else this.closeAutonomous();
    }
  }

  private openAutonomous(event: AppEvent): EmitFn | null {
    if (event.type === "session" || event.type === "rate-limit") return null;
    const request = this.lastRequest;
    if (!request?.openAutonomousTurn || this.closed) return null;
    this.clearIdle();
    this.autonomous = request.openAutonomousTurn({
      steer: async (input) => {
        if (this.autonomous === null || this.closed) return false;
        return this.write(request.steerLine(input.prompt, input.images));
      },
      cancel: () => {
        const emit = this.autonomous;
        if (emit === null) return;
        this.autonomous = null;
        emit({ type: "status", state: "error", error: "annulé" });
        this.destroy();
      },
    });
    return this.autonomous;
  }

  private closeAutonomous(): void {
    if (this.autonomous === null) return;
    this.autonomous = null;
    if (!this.closed) this.armIdle();
  }

  private handleGone(detail: string): void {
    if (this.closed) return;
    this.closed = true;
    const turn = this.turn;
    if (turn && !turn.settled) {
      turn.emit({ type: "status", state: "error", error: detail });
    }
    const autonomous = this.autonomous;
    this.autonomous = null;
    autonomous?.({ type: "status", state: "error", error: detail });
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
    this.idleSince = Date.now();
    this.scheduleIdleCheck();
  }

  private scheduleIdleCheck(): void {
    const timer = setTimeout(() => {
      this.idleTimer = null;
      const since = this.idleSince ?? Date.now();
      if (this.backgroundTasks > 0 && Date.now() - since < backgroundMaxMs()) {
        this.scheduleIdleCheck();
        return;
      }
      this.destroy();
    }, idleMs());
    timer.unref?.();
    this.idleTimer = timer;
  }

  private clearIdle(): void {
    this.idleSince = null;
    if (this.idleTimer === null) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  destroy(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearIdle();
    const autonomous = this.autonomous;
    this.autonomous = null;
    autonomous?.({ type: "status", state: "error", error: "process Claude arrêté" });
    killGroup(this.child, "SIGTERM");
    const forceKill = setTimeout(() => killGroup(this.child, "SIGKILL"), 3_000);
    forceKill.unref?.();
    this.onGone(this);
  }

  run(request: ClaudeTurnRequest): Promise<void> {
    return new Promise((resolve) => {
      this.clearIdle();
      this.lastRequest = request;
      const autonomous = this.autonomous;
      this.autonomous = null;
      autonomous?.({ type: "status", state: "done" });
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
