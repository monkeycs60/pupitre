import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { AppEvent } from "../events";
import type { EmitFn, TurnOptions } from "./types";
import { codexMcpConfig } from "../conductor";
import { codexPupitreMcpServer } from "../pupitre";
import { boundedToolOutput } from "./output";
import { aiRoots, DEFAULT_FILESYSTEM_SCOPE } from "../access";

// Client du protocole `codex app-server` (JSON-RPC newline-delimited sur stdio).
// Un SEUL process partagé par tout le sidecar : démarrage paresseux au premier
// tour, redémarrage automatique s'il meurt. Les notifications sont routées par
// `threadId` vers le tour actif correspondant.
//
// Les noms de méthodes et de champs viennent des types générés par
// `codex app-server generate-ts` (v2/) et de la fixture réelle
// tests/fixtures/codex-app-server-basic.jsonl.

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_IDLE_MS = 5 * 60_000;
const DEFAULT_MCP_STARTUP_TIMEOUT_SEC = 5;

type McpPolicy = "bounded" | "full" | "off";

type McpNameProvider = (bin: string) => string[];

function discoverEnabledMcpNames(bin: string): string[] {
  void bin;
  try {
    const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    const names = config.split("\n").flatMap((line) => {
      const bare = line.match(/^\s*\[mcp_servers\.([A-Za-z0-9_-]+)\]\s*$/);
      if (bare) return [bare[1]!];
      const quoted = line.match(/^\s*\[mcp_servers\.("(?:\\.|[^"])+")\]\s*$/);
      if (!quoted) return [];
      try {
        const name = JSON.parse(quoted[1]!) as unknown;
        return typeof name === "string" && /^[A-Za-z0-9_-]+$/.test(name) ? [name] : [];
      } catch {
        return [];
      }
    });
    return [...new Set(names)];
  } catch {
    // Une installation sans config utilisateur n'a simplement rien à isoler.
    return [];
  }
}

/** Délai au-delà duquel une requête JSON-RPC sans réponse est rejetée. */
function requestTimeoutMs(): number {
  const raw = Number(process.env.PUPITRE_APPSERVER_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

/** Durée d'inactivité hors tour avant d'arrêter le process partagé. */
function appServerIdleMs(): number {
  const raw = Number(process.env.PUPITRE_APPSERVER_IDLE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_IDLE_MS;
}

/** Politique appliquée aux MCP/plugins utilisateur du process app-server. */
function mcpPolicy(): McpPolicy {
  const configured = process.env.PUPITRE_CODEX_MCP_POLICY;
  if (configured === undefined) {
    // Compatibilité avec l'opt-in introduit avant la politique bornée.
    return process.env.PUPITRE_CODEX_USER_MCPS === "1" ? "full" : "bounded";
  }
  if (configured === "bounded" || configured === "full" || configured === "off") {
    return configured;
  }
  throw new Error(
    `PUPITRE_CODEX_MCP_POLICY invalide : ${configured} (attendu : bounded, full ou off)`,
  );
}

/** Temps maximal laissé à chaque MCP classique pour terminer son handshake. */
function mcpStartupTimeoutSec(): number {
  const raw = Number(process.env.PUPITRE_CODEX_MCP_STARTUP_TIMEOUT_SEC);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MCP_STARTUP_TIMEOUT_SEC;
}

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
  private activeRuns = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Tue le process courant ET fait son cleanup (cf. shutdown). */
  private killCurrent: (() => void) | null = null;
  private discoveredMcpNames: string[] | null = null;
  /** Faux uniquement face à un app-server ancien qui a rejeté l'opt-in. */
  private experimentalApi = true;

  constructor(private readonly mcpNames: McpNameProvider = discoverEnabledMcpNames) {}

  /** Même signature que runCodexTurn : un tour complet, streamé via emit. */
  async runTurn(opts: TurnOptions, emit: EmitFn): Promise<void> {
    this.activeRuns += 1;
    this.clearIdleWatchdog();
    try {
      await this.runActiveTurn(opts, emit);
    } finally {
      this.activeRuns -= 1;
      this.scheduleIdleWatchdog();
    }
  }

  private async runActiveTurn(opts: TurnOptions, emit: EmitFn): Promise<void> {
    emit({ type: "status", state: "running" });
    const cancelled = () => {
      if (!opts.signal?.aborted) return false;
      emit({ type: "status", state: "error", error: "annulé" });
      return true;
    };
    if (cancelled()) return;

    // Le setup (spawn + handshake + thread) peut durer : on revérifie le signal
    // entre chaque await pour qu'une annulation pendant cette phase aboutisse.
    let threadId: string;
    try {
      await this.ensureProcess();
      if (cancelled()) return;
      threadId = await this.openThread(opts);
    } catch (error) {
      emit({ type: "status", state: "error", error: String(error) });
      return;
    }
    if (cancelled()) return;

    // Un même thread ne peut pas porter deux tours simultanés : le routage des
    // notifications se fait par threadId, on refuse plutôt que de mélanger.
    if (this.turns.has(threadId)) {
      emit({
        type: "status",
        state: "error",
        error: `un tour est déjà actif sur le thread ${threadId}`,
      });
      return;
    }

    emit({ type: "session", provider: "codex", cliSessionId: threadId, model: opts.model });

    let done!: () => void;
    const finished = new Promise<void>((resolve) => (done = resolve));
    const ctx = new TurnContext(threadId, emit, done);
    this.turns.set(threadId, ctx);

    let abortRequested = false;
    let interruptSent = false;
    const interruptStartedTurn = () => {
      if (!ctx.turnId || interruptSent) return;
      interruptSent = true;
      // turn/interrupt {threadId, turnId} — confirmé par les types v2 générés.
      this.request("turn/interrupt", { threadId, turnId: ctx.turnId }).catch(() => {});
    };
    const abort = () => {
      abortRequested = true;
      interruptStartedTurn();
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
        serviceTier: opts.speed === "fast" ? "fast" : null,
      });
      ctx.turnId = (started?.turn as { id?: string } | undefined)?.id ?? null;
      // Une annulation peut arriver pendant que turn/start attend sa réponse :
      // le tour existe alors côté app-server, mais son id n'est connu qu'ici.
      if (abortRequested || opts.signal?.aborted) interruptStartedTurn();
      await finished;
    } catch (error) {
      ctx.finish({ type: "status", state: "error", error: String(error) });
    } finally {
      opts.signal?.removeEventListener("abort", abort);
      this.turns.delete(threadId);
    }
  }

  /**
   * Poll de l'état de quota (`account/rateLimits/read`, cf. fixture du spike).
   * Ne démarre PAS le process : appelé au boot du sidecar, il ne renvoie un
   * état que si un tour codex a déjà réveillé l'app-server. Sinon le premier
   * tour codex fournira l'état via `account/rateLimits/updated`.
   */
  async readRateLimits(): Promise<unknown | null> {
    if (!this.ready || !this.proc) return null;
    this.clearIdleWatchdog();
    try {
      await this.ready;
      const result = await this.request("account/rateLimits/read", {});
      return (result as { rateLimits?: unknown } | null)?.rateLimits ?? null;
    } finally {
      this.scheduleIdleWatchdog();
    }
  }

  /**
   * Ferme le process partagé (tests / arrêt du sidecar). Fait le MÊME cleanup
   * que la mort du process : sans ça, remettre `proc` à null court-circuiterait
   * le handler `close` et laisserait les tours actifs suspendus pour toujours.
   */
  shutdown(): void {
    this.clearIdleWatchdog();
    const kill = this.killCurrent;
    this.killCurrent = null;
    kill?.();
    this.proc = null;
    this.ready = null;
  }

  // --- Process partagé -----------------------------------------------------

  private clearIdleWatchdog(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private scheduleIdleWatchdog(): void {
    this.clearIdleWatchdog();
    if (!this.proc || this.activeRuns > 0 || this.pending.size > 0) return;

    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.proc || this.activeRuns > 0 || this.pending.size > 0) {
        this.scheduleIdleWatchdog();
        return;
      }
      const kill = this.killCurrent;
      this.killCurrent = null;
      kill?.();
    }, appServerIdleMs());
    this.idleTimer.unref?.();
  }

  private noteProcessOutput(): void {
    if (this.activeRuns === 0) this.scheduleIdleWatchdog();
  }

  private ensureProcess(): Promise<void> {
    if (this.ready) return this.ready;
    const bin = process.env.PUPITRE_CODEX_BIN ?? "codex";
    const policy = mcpPolicy();
    // Le handshake des MCP est sur le chemin critique de thread/start. Le mode
    // par défaut leur laisse une fenêtre courte sans supprimer les capacités ;
    // `off` reste disponible pour isoler une panne et `full` respecte la config.
    let args = ["app-server"];
    if (policy !== "full") {
      if (this.discoveredMcpNames === null) this.discoveredMcpNames = this.mcpNames(bin);
      const startupTimeout = mcpStartupTimeoutSec();
      const mcpArgs = this.discoveredMcpNames.flatMap((name) => [
        "-c",
        policy === "bounded"
          ? `mcp_servers.${name}.startup_timeout_sec=${startupTimeout}`
          : `mcp_servers.${name}.enabled=false`,
      ]);
      args = policy === "off"
        ? ["app-server", "--disable", "plugins", ...mcpArgs]
        : ["app-server", ...mcpArgs];
    }
    // `detached` isole l'app-server dans son propre groupe de process : c'est ce
    // qui permet de tuer d'un coup ses serveurs MCP (npx, plugins…), sinon
    // orphelins à chaque arrêt — le « bloat » observé en dizaines de process.
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], detached: true });
    this.proc = child;
    const killTree = () => {
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        child.kill();
      }
      // Filet : un app-server sourd à SIGTERM (ou un MCP qui l'ignore) est
      // achevé sans bloquer l'arrêt du sidecar.
      const forceKill = setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // Groupe déjà terminé : rien à achever.
        }
      }, 1_500);
      forceKill.unref?.();
    };

    const lines = createInterface({ input: child.stdout! });
    lines.on("line", (line) => this.handleLine(line));

    let stderr = "";
    child.stderr!.on("data", (data) => {
      stderr = (stderr + data).slice(-2000);
      this.noteProcessOutput();
    });
    const onDead = (reason: string) => {
      if (this.proc !== child) return;
      // Même un app-server mort de lui-même laisse ses serveurs MCP derrière :
      // le groupe de process est balayé quelle que soit la cause de l'arrêt.
      killTree();
      this.proc = null;
      this.ready = null;
      this.killCurrent = null;
      this.clearIdleWatchdog();
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
    this.killCurrent = () => {
      killTree();
      onDead("codex app-server arrêté (shutdown)");
    };

    const clientInfo = { name: "pupitre", title: "Pupitre", version: "0.1.0" };
    this.experimentalApi = true;
    this.ready = this.request("initialize", {
      clientInfo,
      // `thread/start.runtimeWorkspaceRoots` est expérimental dans le
      // protocole app-server. Pupitre l'utilise pour borner les racines
      // accessibles au thread : il faut donc négocier explicitement l'API
      // expérimentale dès le handshake.
      capabilities: { experimentalApi: true },
    }).catch((error) => {
      // Un app-server plus ancien peut rejeter le champ `capabilities` tout
      // entier : sans ce repli, toutes les conversations Codex deviendraient
      // indisponibles. On retente nu, et openThread renonce alors aux champs
      // expérimentaux (runtimeWorkspaceRoots) pour ne pas re-échouer plus loin.
      if (this.proc !== child) throw error;
      this.experimentalApi = false;
      return this.request("initialize", { clientInfo }).then(() => undefined);
    }).then(() => {
      this.notify("initialized", {});
    });
    // Un handshake raté ne doit pas empoisonner les tours suivants — ni laisser
    // un process orphelin quand l'échec est une erreur JSON-RPC (process vivant).
    this.ready.catch(() => {
      if (this.proc === child) {
        killTree();
        this.proc = null;
        this.ready = null;
        this.killCurrent = null;
      }
    });
    return this.ready;
  }

  private async openThread(opts: TurnOptions): Promise<string> {
    const scope = opts.filesystemScope ?? DEFAULT_FILESYSTEM_SCOPE;
    const readOnly = opts.sandboxMode === "read-only";
    const fullSystem = scope === "full-system" && !readOnly;
    const settings = {
      model: opts.model,
      cwd: opts.cwd,
      approvalPolicy: "never",
      // Les tours normaux peuvent modifier les instructions et la mémoire
      // globales demandées par l'utilisateur. Les appels de review/debrief
      // passent explicitement `read-only` et ne suivent donc pas ce défaut.
      sandbox: opts.sandboxMode ?? (fullSystem ? "danger-full-access" : "workspace-write"),
      ...(!fullSystem && this.experimentalApi
        ? { runtimeWorkspaceRoots: [opts.cwd, ...aiRoots()] }
        : {}),
      // null est volontaire : un thread repris conserve sinon son tier `fast`.
      serviceTier: opts.speed === "fast" ? "fast" : null,
    };
    // `config` est un override de configuration PAR THREAD (ThreadStartParams /
    // ThreadResumeParams, objet libre aux clés de `config.toml`). C'est ce qui
    // permet de câbler le bridge MCP `conductor` avec le bon
    // PUPITRE_CONVERSATION_ID alors que le process app-server est partagé par
    // tout le sidecar : chaque thread démarre ses propres serveurs MCP.
    // L'effort passe par `turn/start` (champ `effort` des types v2) ; on le
    // duplique en config pour les versions qui ne l'honorent qu'au niveau thread.
    const conductorConfig = opts.conductor ? codexMcpConfig(opts.conductor) : {};
    const conductorServers = (
      conductorConfig.mcp_servers as Record<string, Record<string, unknown>> | undefined
    ) ?? {};
    const pupitreServers = opts.pupitre
      ? { pupitre: codexPupitreMcpServer(opts.pupitre) }
      : {};
    // Ajouter `mcp_servers` dans la config du thread fait repasser cette branche
    // après les overrides CLI du process. Sans recopier la politique utilisateur,
    // le conductor restaurait donc notamment le timeout Sentry de 120 secondes.
    // Sélection du projet : tout serveur non retenu est désactivé pour CE
    // thread. Codex n'accepte pas de définitions inline comme Claude, mais
    // `enabled = false` par serveur donne le même résultat.
    const projectFilter = opts.mcpAllowed
      ? Object.fromEntries(
        this.knownMcpNames()
          .filter((name) => !opts.mcpAllowed!.includes(name))
          .map((name) => [name, { enabled: false }]),
      )
      : {};
    const threadMcpServers = {
      ...(opts.conductor || opts.pupitre ? this.threadMcpPolicyOverrides() : {}),
      ...projectFilter,
      ...(opts.conductor ? conductorServers : {}),
      ...pupitreServers,
    };
    const overrides = {
      ...(opts.effort ? { model_reasoning_effort: opts.effort } : {}),
      ...(Object.keys(threadMcpServers).length ? { mcp_servers: threadMcpServers } : {}),
    };
    const config = Object.keys(overrides).length ? { config: overrides } : {};
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

  /** Noms des serveurs MCP déclarés dans la config Codex, découverts une fois. */
  private knownMcpNames(): string[] {
    if (this.discoveredMcpNames === null) {
      const bin = process.env.PUPITRE_CODEX_BIN ?? "codex";
      this.discoveredMcpNames = this.mcpNames(bin);
    }
    return this.discoveredMcpNames;
  }

  /** Réapplique au thread orchestrateur la politique déjà passée au process. */
  private threadMcpPolicyOverrides(): Record<string, Record<string, unknown>> {
    const policy = mcpPolicy();
    if (policy === "full") return {};
    if (this.discoveredMcpNames === null) {
      const bin = process.env.PUPITRE_CODEX_BIN ?? "codex";
      this.discoveredMcpNames = this.mcpNames(bin);
    }
    const startupTimeout = mcpStartupTimeoutSec();
    return Object.fromEntries(this.discoveredMcpNames.map((name) => [
      name,
      policy === "bounded"
        ? { startup_timeout_sec: startupTimeout }
        : { enabled: false },
    ]));
  }

  // --- Transport JSON-RPC --------------------------------------------------

  private request(method: string, params: Record<string, unknown>): Promise<any> {
    const child = this.proc;
    if (!child) return Promise.reject(new Error("codex app-server non démarré"));
    const id = this.nextId++;
    const timeoutMs = requestTimeoutMs();
    return new Promise((resolve, reject) => {
      // Sans réponse au bout de `timeoutMs`, la requête est abandonnée : sinon
      // un app-server muet suspendrait le tour indéfiniment.
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout ${method} après ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
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
      this.noteProcessOutput();
      return; // ligne non-JSON (bruit de démarrage) : ignorée
    }
    if (message.id !== undefined && message.method === undefined) {
      const request = this.pending.get(message.id as number);
      if (!request) return;
      this.pending.delete(message.id as number);
      if (message.error) request.reject(new Error(message.error.message ?? "erreur JSON-RPC"));
      else request.resolve(message.result as any);
      this.noteProcessOutput();
      return;
    }
    this.noteProcessOutput();
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
        if (ctx.isSettled) continue; // pas d'event après le status terminal
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
          const contextTokens = numberOrZero(last.totalTokens)
            || numberOrZero(last.inputTokens) + numberOrZero(last.outputTokens);
          const contextWindowTokens = numberOrZero(usage?.modelContextWindow);
          ctx.emit({
            type: "usage",
            inputTokens: numberOrZero(last.inputTokens),
            outputTokens: numberOrZero(last.outputTokens),
            ...(contextTokens > 0 ? { contextTokens } : {}),
            ...(contextWindowTokens > 0 ? { contextWindowTokens } : {}),
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
        // Codex app-server ne passe pas ses éditions par une commande bash
        // visible : il décrit chaque fichier touché dans `commandActions`
        // ({ type, path, name }). On les remonte pour que l'UI affiche les
        // chips de fichiers d'un tour Codex (les lectures y sont filtrées).
        const actions = Array.isArray(item.commandActions)
          ? item.commandActions.flatMap((raw: unknown) => {
              const action = raw as Record<string, unknown> | undefined;
              return action && typeof action.path === "string"
                ? [{ type: String(action.type ?? ""), path: action.path }]
                : [];
            })
          : [];
        ctx.emit({
          type: "tool-start",
          toolId: item.id,
          toolName: "shell",
          input: { command: String(item.command ?? ""), actions },
        });
      } else {
        ctx.emit({
          type: "tool-end",
          toolId: item.id,
          output: boundedToolOutput(item.aggregatedOutput),
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
