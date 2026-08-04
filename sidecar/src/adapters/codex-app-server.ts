import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { AppEvent } from "../events";
import type { EmitFn, TurnOptions } from "./types";

// Client du protocole `codex app-server` (JSON-RPC newline-delimited sur stdio).
// Un SEUL process partagé par tout le sidecar : démarrage paresseux au premier
// tour, redémarrage automatique s'il meurt. Les notifications sont routées par
// `threadId` vers le tour actif correspondant.
//
// Les noms de méthodes et de champs viennent des types générés par
// `codex app-server generate-ts` (v2/) et de la fixture réelle
// tests/fixtures/codex-app-server-basic.jsonl.

const OUTPUT_LIMIT = 10_000;

interface JsonRpcMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message?: string };
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

class TurnContext {
  turnId: string | null = null;
  private settled = false;

  constructor(
    readonly threadId: string,
    readonly emit: EmitFn,
    private readonly done: () => void,
  ) {}

  get isSettled(): boolean {
    return this.settled;
  }

  /** Émet le status terminal (une seule fois) et débloque runTurn. */
  finish(status: AppEvent): void {
    if (this.settled) return;
    this.settled = true;
    this.emit(status);
    this.done();
  }
}

export class CodexAppServerClient {
  private proc: ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private turns = new Map<string, TurnContext>();

  /** Même signature que runCodexTurn : un tour complet, streamé via emit. */
  async runTurn(opts: TurnOptions, emit: EmitFn): Promise<void> {
    emit({ type: "status", state: "running" });
    if (opts.signal?.aborted) {
      emit({ type: "status", state: "error", error: "annulé" });
      return;
    }

    let threadId: string;
    try {
      await this.ensureProcess();
      threadId = await this.openThread(opts);
    } catch (error) {
      emit({ type: "status", state: "error", error: String(error) });
      return;
    }

    emit({ type: "session", provider: "codex", cliSessionId: threadId, model: opts.model });

    let done!: () => void;
    const finished = new Promise<void>((resolve) => (done = resolve));
    const ctx = new TurnContext(threadId, emit, done);
    this.turns.set(threadId, ctx);

    const abort = () => {
      if (ctx.isSettled) return;
      // turn/interrupt {threadId, turnId} — confirmé par les types v2 générés.
      if (ctx.turnId) {
        this.request("turn/interrupt", { threadId, turnId: ctx.turnId }).catch(() => {});
      }
      ctx.finish({ type: "status", state: "error", error: "annulé" });
    };
    opts.signal?.addEventListener("abort", abort, { once: true });

    try {
      const started = await this.request("turn/start", {
        threadId,
        input: [
          { type: "text", text: opts.prompt },
          ...opts.images.map((path) => ({ type: "localImage", path })),
        ],
        model: opts.model,
        ...(opts.effort ? { effort: opts.effort } : {}),
        ...(opts.speed === "fast" ? { serviceTier: "fast" } : {}),
      });
      ctx.turnId = (started?.turn as { id?: string } | undefined)?.id ?? null;
      if (opts.signal?.aborted) abort();
      await finished;
    } catch (error) {
      ctx.finish({ type: "status", state: "error", error: String(error) });
    } finally {
      opts.signal?.removeEventListener("abort", abort);
      this.turns.delete(threadId);
    }
  }

  /** Ferme le process partagé (tests / arrêt du sidecar). */
  shutdown(): void {
    this.proc?.kill();
    this.proc = null;
    this.ready = null;
  }

  // --- Process partagé -----------------------------------------------------

  private ensureProcess(): Promise<void> {
    if (this.ready) return this.ready;
    const bin = process.env.PUPITRE_CODEX_BIN ?? "codex";
    const child = spawn(bin, ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
    this.proc = child;

    const lines = createInterface({ input: child.stdout! });
    lines.on("line", (line) => this.handleLine(line));

    let stderr = "";
    child.stderr!.on("data", (data) => {
      stderr = (stderr + data).slice(-2000);
    });
    const onDead = (reason: string) => {
      if (this.proc !== child) return;
      this.proc = null;
      this.ready = null;
      const error = new Error(reason + (stderr ? ` : ${stderr}` : ""));
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
      for (const ctx of this.turns.values()) {
        ctx.finish({ type: "status", state: "error", error: error.message });
      }
      this.turns.clear();
    };
    child.on("error", (error) => onDead(String(error)));
    child.on("close", (code) => onDead(`codex app-server arrêté (exit ${code})`));

    this.ready = this.request("initialize", {
      clientInfo: { name: "pupitre", title: "Pupitre", version: "0.1.0" },
      capabilities: null,
    }).then(() => {
      this.notify("initialized", {});
    });
    // Un handshake raté ne doit pas empoisonner les tours suivants.
    this.ready.catch(() => {
      if (this.proc === child) {
        this.proc = null;
        this.ready = null;
      }
    });
    return this.ready;
  }

  private async openThread(opts: TurnOptions): Promise<string> {
    const settings = {
      model: opts.model,
      cwd: opts.cwd,
      approvalPolicy: "never",
      sandbox: "workspace-write",
      ...(opts.speed === "fast" ? { serviceTier: "fast" } : {}),
    };
    // L'effort passe par `turn/start` (champ `effort` des types v2) ; on le
    // duplique en config pour les versions qui ne l'honorent qu'au niveau thread.
    const config = opts.effort ? { config: { model_reasoning_effort: opts.effort } } : {};
    const result = opts.cliSessionId
      ? await this.request("thread/resume", {
          threadId: opts.cliSessionId,
          ...settings,
          ...config,
        })
      : await this.request("thread/start", { ...settings, ...config });
    const threadId = (result?.thread as { id?: string } | undefined)?.id;
    if (typeof threadId !== "string") throw new Error("thread sans id");
    return threadId;
  }

  // --- Transport JSON-RPC --------------------------------------------------

  private request(method: string, params: Record<string, unknown>): Promise<any> {
    const child = this.proc;
    if (!child) return Promise.reject(new Error("codex app-server non démarré"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private respond(id: number | string, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  private write(message: unknown): void {
    this.proc?.stdin?.write(JSON.stringify(message) + "\n");
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line);
    } catch {
      return; // ligne non-JSON (bruit de démarrage) : ignorée
    }
    if (message.id !== undefined && message.method === undefined) {
      const request = this.pending.get(message.id as number);
      if (!request) return;
      this.pending.delete(message.id as number);
      if (message.error) request.reject(new Error(message.error.message ?? "erreur JSON-RPC"));
      else request.resolve(message.result as any);
      return;
    }
    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message.id, message.method);
      return;
    }
    if (message.method) this.handleNotification(message.method, message.params ?? {});
  }

  private handleServerRequest(id: number | string, method: string): void {
    // M1-style : auto-accept de toutes les approbations (le vrai flux
    // d'approbation interactif — remontée à l'UI, choix utilisateur — arrivera
    // dans un lot ultérieur). `accept` est le nom de décision des types v2.
    if (method.startsWith("item/") && method.endsWith("requestApproval")) {
      this.respond(id, { decision: "accept" });
      return;
    }
    this.respond(id, {});
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    if (method === "account/rateLimits/updated") {
      // Pas de threadId sur cet event : il concerne le compte entier.
      for (const ctx of this.turns.values()) {
        ctx.emit({ type: "rate-limit", provider: "codex", payload: params.rateLimits ?? params });
      }
      return;
    }

    const threadId = params.threadId;
    if (typeof threadId !== "string") return;
    const ctx = this.turns.get(threadId);
    if (!ctx || ctx.isSettled) return;

    switch (method) {
      case "item/agentMessage/delta": {
        if (typeof params.delta === "string" && params.delta) {
          ctx.emit({ type: "text-delta", text: params.delta });
        }
        return;
      }
      case "item/started":
      case "item/completed": {
        this.handleItem(ctx, method === "item/started", params.item);
        return;
      }
      case "thread/tokenUsage/updated": {
        const usage = params.tokenUsage as Record<string, any> | undefined;
        const last = usage?.last ?? usage?.total;
        if (last) {
          ctx.emit({
            type: "usage",
            inputTokens: numberOrZero(last.inputTokens),
            outputTokens: numberOrZero(last.outputTokens),
          });
        }
        return;
      }
      case "turn/completed": {
        const turn = params.turn as Record<string, any> | undefined;
        const status = turn?.status;
        if (status === "failed") {
          ctx.finish({
            type: "status",
            state: "error",
            error: String(turn?.error?.message ?? "turn failed"),
          });
        } else if (status === "interrupted") {
          ctx.finish({ type: "status", state: "error", error: "annulé" });
        } else {
          ctx.finish({ type: "status", state: "done" });
        }
        return;
      }
      case "turn/failed": {
        // Absent des types v2 actuels, gardé par prudence (ancien nom).
        const error = params.error as Record<string, unknown> | undefined;
        ctx.finish({
          type: "status",
          state: "error",
          error: String(error?.message ?? "turn failed"),
        });
        return;
      }
      default:
        return;
    }
  }

  private handleItem(ctx: TurnContext, started: boolean, raw: unknown): void {
    const item = raw as Record<string, any> | undefined;
    if (!item || typeof item.id !== "string") return;

    if (item.type === "agentMessage") {
      if (!started && typeof item.text === "string" && item.text) {
        ctx.emit({ type: "text-final", text: item.text });
      }
      return;
    }
    if (item.type === "commandExecution") {
      if (started) {
        ctx.emit({
          type: "tool-start",
          toolId: item.id,
          toolName: "shell",
          input: { command: String(item.command ?? "") },
        });
      } else {
        ctx.emit({
          type: "tool-end",
          toolId: item.id,
          output: String(item.aggregatedOutput ?? "").slice(0, OUTPUT_LIMIT),
          images: [],
        });
      }
    }
  }
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

// Instance partagée par le sidecar (un seul process app-server au total).
export const codexAppServer = new CodexAppServerClient();

export function runCodexAppServerTurn(opts: TurnOptions, emit: EmitFn): Promise<void> {
  return codexAppServer.runTurn(opts, emit);
}
