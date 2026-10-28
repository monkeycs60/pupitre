import { createHash, randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { killGroup, spawnGroup } from "./process-group";
import { createPupitreServer } from "./pupitre-mcp";
import type { PupitreTarget } from "./pupitre";

const DEFAULT_IDLE_MS = 10 * 60_000;
const INITIALIZE_TIMEOUT_MS = 90_000;
const HUB_PROTOCOL_VERSION = "2025-06-18";

/** Serveurs qui tiennent un navigateur ou une session : un par agent. */
const STATEFUL_SERVER = /playwright|puppeteer|browsermcp|chrome-devtools|selenium|browser/i;

type JsonRpcId = string | number;
type JsonRpcMessage = {
  jsonrpc?: string;
  id?: JsonRpcId | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

export interface StdioServer {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

function readJson(path: string): Record<string, any> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
  } catch {
    return null;
  }
}

function expand(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, fallback?: string) =>
    process.env[name] ?? fallback ?? "");
}

function stdioDefinition(definition: unknown): Omit<StdioServer, "cwd"> | null {
  if (!definition || typeof definition !== "object") return null;
  const raw = definition as Record<string, unknown>;
  if (raw.type !== undefined && raw.type !== "stdio") return null;
  if (typeof raw.command !== "string" || raw.command.length === 0) return null;
  const args = Array.isArray(raw.args) ? raw.args.filter((arg): arg is string => typeof arg === "string") : [];
  const env = raw.env && typeof raw.env === "object"
    ? Object.fromEntries(Object.entries(raw.env as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .map(([name, value]) => [name, expand(value)]))
    : {};
  return { command: expand(raw.command), args: args.map(expand), env };
}

function isShareable(server: Omit<StdioServer, "cwd">): boolean {
  if (Object.keys(server.env).some((name) => name.startsWith("PUPITRE_"))) return false;
  return !STATEFUL_SERVER.test([server.command, ...server.args].join(" "));
}

function sameDefinition(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

const NPX_QUIET_FLAGS = new Set(["-y", "--yes", "-q", "--quiet"]);

/**
 * Lancement direct du binaire qu'`npx <paquet>` exécuterait depuis son cache
 * (`~/.npm/_npx`), sans le process `npm exec` qui l'enveloppe. Null quand le
 * paquet n'y est pas encore, quand le projet l'installe lui-même ou quand les
 * options d'npx sortent du cas simple : npx garde alors la main.
 */
export function npxDirectLaunch(server: StdioServer, home = homedir()): StdioServer | null {
  if (basename(server.command) !== "npx") return null;
  const specIndex = server.args.findIndex((arg) => !NPX_QUIET_FLAGS.has(arg));
  const spec = server.args[specIndex];
  if (spec === undefined || spec.startsWith("-")) return null;
  const at = spec.indexOf("@", 1);
  const name = at === -1 ? spec : spec.slice(0, at);
  const wanted = at === -1 || spec.slice(at + 1) === "latest" ? "*" : spec.slice(at + 1);
  if (!/^[\d\s.*xX^~<>=|-]+$/.test(wanted)) return null;
  if (existsSync(join(server.cwd, "node_modules", name))) return null;
  const cache = join(process.env.npm_config_cache ?? join(home, ".npm"), "_npx");
  let entries: string[];
  try {
    entries = readdirSync(cache);
  } catch {
    return null;
  }
  let best: { version: string; root: string; bin: unknown } | null = null;
  for (const entry of entries) {
    const root = join(cache, entry, "node_modules");
    const manifest = readJson(join(root, name, "package.json"));
    if (typeof manifest?.version !== "string") continue;
    if (!Bun.semver.satisfies(manifest.version, wanted)) continue;
    if (best === null || Bun.semver.order(manifest.version, best.version) > 0) {
      best = { version: manifest.version, root, bin: manifest.bin };
    }
  }
  if (best === null) return null;
  const unscoped = name.split("/").at(-1)!;
  const bins = typeof best.bin === "string" ? [unscoped] : Object.keys((best.bin as object | undefined) ?? {});
  const binName = bins.length === 1 ? bins[0] : bins.find((candidate) => candidate === unscoped);
  if (binName === undefined) return null;
  const bin = join(best.root, ".bin", binName);
  if (!existsSync(bin)) return null;
  const path = server.env.PATH ?? process.env.PATH ?? "";
  return {
    command: bin,
    args: server.args.slice(specIndex + 1),
    env: { ...server.env, PATH: `${join(best.root, ".bin")}:${path}` },
    cwd: server.cwd,
  };
}

/**
 * Dossier sous lequel `~/.claude.json` range la config locale de `cwd` : un
 * worktree Git partage celle de son dépôt principal.
 */
function projectConfigKey(cwd: string, projects: Record<string, unknown>): string {
  if (cwd in projects) return cwd;
  try {
    const pointer = readFileSync(join(cwd, ".git"), "utf8").match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
    const main = pointer?.match(/^(.*)\/\.git\/worktrees\/[^/]+$/)?.[1];
    if (main && main in projects) return main;
  } catch {}
  return cwd;
}

/**
 * Serveurs que le CLI Claude démarrerait lui-même dans `cwd` sans
 * `--strict-mcp-config` : scope utilisateur, `.mcp.json` approuvé, scope local,
 * moins les serveurs désactivés pour ce dossier.
 */
export function claudeLoadedServers(cwd: string, home = homedir()): Record<string, unknown> {
  const claudeConfig = readJson(join(home, ".claude.json"));
  const projects = claudeConfig?.projects ?? {};
  const local = projects[projectConfigKey(cwd, projects)] ?? {};
  const settings = [
    readJson(join(home, ".claude", "settings.json")),
    readJson(join(cwd, ".claude", "settings.json")),
    readJson(join(cwd, ".claude", "settings.local.json")),
    local,
  ].filter((value): value is Record<string, any> => value !== null);
  const listed = (key: string) => new Set(settings.flatMap((value) =>
    Array.isArray(value[key]) ? value[key].filter((name: unknown) => typeof name === "string") : []));
  const enableAll = settings.some((value) => value.enableAllProjectMcpServers === true);
  const enabledProject = listed("enabledMcpjsonServers");
  const disabledProject = listed("disabledMcpjsonServers");
  const projectServers = Object.fromEntries(
    Object.entries(readJson(join(cwd, ".mcp.json"))?.mcpServers ?? {})
      .filter(([name]) => (enableAll || enabledProject.has(name)) && !disabledProject.has(name)),
  );
  const disabled = new Set(Array.isArray(local.disabledMcpServers) ? local.disabledMcpServers : []);
  return Object.fromEntries(
    Object.entries({
      ...(claudeConfig?.mcpServers ?? {}),
      ...projectServers,
      ...(local.mcpServers ?? {}),
    }).filter(([name]) => !disabled.has(name)),
  );
}

interface PendingRequest {
  resolve: (message: JsonRpcMessage) => void;
}

class Upstream {
  private child: ChildProcess | null = null;
  private ready: Promise<unknown> | null = null;
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private stderr = "";

  constructor(
    readonly label: string,
    private readonly server: StdioServer,
    private readonly idleMs: number,
    private readonly home: string,
  ) {}

  get running(): boolean {
    return this.child !== null;
  }

  /** Résultat de `initialize`, partagé par tous les clients du serveur. */
  async initialize(protocolVersion: string): Promise<unknown> {
    this.ready ??= this.start(protocolVersion);
    const result = await this.ready;
    this.armIdle();
    return result;
  }

  async request(method: string, params: unknown, signal?: AbortSignal): Promise<JsonRpcMessage> {
    await this.initialize(HUB_PROTOCOL_VERSION);
    return this.send(method, params, signal);
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  stop(): void {
    const child = this.child;
    if (child === null) return;
    this.child = null;
    this.ready = null;
    this.clearIdle();
    killGroup(child, "SIGTERM");
    const forceKill = setTimeout(() => killGroup(child, "SIGKILL"), 3_000);
    forceKill.unref?.();
    this.failPending("serveur MCP arrêté");
  }

  private async start(protocolVersion: string): Promise<unknown> {
    const launch = npxDirectLaunch(this.server, this.home) ?? this.server;
    const child = spawnGroup(launch.command, launch.args, {
      cwd: launch.cwd,
      env: { ...process.env, ...launch.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.stderr = "";
    createInterface({ input: child.stdout! }).on("line", (line) => this.handleLine(line));
    child.stderr?.on("data", (chunk) => {
      this.stderr = (this.stderr + String(chunk)).slice(-2_000);
    });
    child.stdin?.on("error", () => {});
    const exited = new Promise<never>((_, reject) => {
      const gone = (detail: string) => {
        if (this.child === child) {
          this.child = null;
          this.ready = null;
          this.clearIdle();
          this.failPending(detail);
        }
        reject(new Error(detail));
      };
      child.on("error", (error) => gone(String(error)));
      child.on("exit", (code, signal) => {
        const detail = `serveur MCP ${this.label} arrêté (${signal ?? `code ${code}`})${this.stderr ? ` : ${this.stderr.trim()}` : ""}`;
        if (this.child === child && code !== 0) console.error(detail);
        gone(detail);
      });
    });
    exited.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`serveur MCP ${this.label} muet après ${INITIALIZE_TIMEOUT_MS / 1_000} s`)), INITIALIZE_TIMEOUT_MS);
    });
    try {
      const response = await Promise.race([
        this.send("initialize", {
          protocolVersion,
          capabilities: {},
          clientInfo: { name: "pupitre-mcp-hub", version: "1" },
        }),
        exited,
        timeout,
      ]);
      if (response.error !== undefined) throw new Error(JSON.stringify(response.error));
      this.notify("notifications/initialized", undefined);
      return response.result;
    } catch (error) {
      console.error(`Démarrage du serveur MCP partagé ${this.label} impossible`, error);
      if (this.child === child) this.stop();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private send(method: string, params: unknown, signal?: AbortSignal): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    this.clearIdle();
    return new Promise((resolve) => {
      const onAbort = () => {
        if (!this.pending.delete(id)) return;
        this.notify("notifications/cancelled", { requestId: id, reason: "client déconnecté" });
        resolve({ jsonrpc: "2.0", id, error: { code: -32800, message: "requête annulée" } });
        this.armIdle();
      };
      this.pending.set(id, {
        resolve: (message) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(message);
        },
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (!this.write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })) {
        this.pending.delete(id);
        resolve({ jsonrpc: "2.0", id, error: { code: -32000, message: `serveur MCP ${this.label} injoignable` } });
      }
    });
  }

  private write(message: JsonRpcMessage): boolean {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed) return false;
    stdin.write(`${JSON.stringify(message)}\n`);
    return true;
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    if (message.method !== undefined) {
      if (message.id !== undefined && message.id !== null) {
        this.write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "non pris en charge par le hub Pupitre" } });
      }
      return;
    }
    if (typeof message.id !== "number") return;
    const request = this.pending.get(message.id);
    if (!request) return;
    this.pending.delete(message.id);
    request.resolve(message);
    if (this.pending.size === 0) this.armIdle();
  }

  private failPending(detail: string): void {
    const pending = [...this.pending.entries()];
    this.pending.clear();
    for (const [id, request] of pending) {
      request.resolve({ jsonrpc: "2.0", id, error: { code: -32000, message: detail } });
    }
  }

  private armIdle(): void {
    this.clearIdle();
    if (this.pending.size > 0 || this.child === null) return;
    const timer = setTimeout(() => this.stop(), this.idleMs);
    timer.unref?.();
    this.idleTimer = timer;
  }

  private clearIdle(): void {
    if (this.idleTimer === null) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

/**
 * Sert chaque serveur MCP stdio une seule fois, en HTTP, à tous les agents
 * Claude du sidecar. Chaque requête reçoit un id propre au serveur partagé :
 * deux agents envoient tous deux leur requête n° 1.
 */
export class McpHub {
  private readonly token = randomUUID();
  private readonly upstreams = new Map<string, Upstream>();
  private port: (() => number) | null = null;

  constructor(
    private readonly options: { idleMs?: number; home?: string } = {},
  ) {}

  attach(port: () => number): void {
    this.port = port;
  }

  private get enabled(): boolean {
    return this.port !== null && process.env.PUPITRE_MCP_HUB !== "0";
  }

  /**
   * Config `--mcp-config` d'un tour Claude. Avec une sélection, tous les
   * serveurs retenus (stdio partageables remplacés par le hub) ; sans
   * sélection, seulement les remplacements : le CLI garde le reste de sa
   * configuration, connecteurs claude.ai et plugins compris.
   */
  claudeServers(cwd: string, selected: Record<string, unknown> | null): Record<string, unknown> {
    if (!this.enabled) return selected ?? {};
    const servers = selected ?? claudeLoadedServers(cwd, this.home);
    const userServers = readJson(join(this.home, ".claude.json"))?.mcpServers ?? {};
    const shared: Record<string, unknown> = {};
    for (const [name, definition] of Object.entries(servers)) {
      const stdio = stdioDefinition(definition);
      if (stdio === null || !isShareable(stdio)) continue;
      const fromUser = sameDefinition(userServers[name], definition);
      shared[name] = { type: "http", url: this.register(name, { ...stdio, cwd: fromUser ? this.home : cwd }) };
    }
    return selected === null ? shared : { ...selected, ...shared };
  }

  /**
   * Pont Pupitre d'un agent Claude, servi en HTTP par le sidecar lui-même :
   * aucun process par agent. Null quand le hub est coupé.
   */
  pupitreServer(target: PupitreTarget): Record<string, unknown> | null {
    if (!this.enabled) return null;
    return {
      type: "http",
      url: `http://127.0.0.1:${this.port!()}/mcp-hub/${this.token}/pupitre/${encodeURIComponent(target.conversationId)}`,
    };
  }

  /** Nombre de serveurs partagés en cours d'exécution. */
  runningCount(): number {
    return [...this.upstreams.values()].filter((upstream) => upstream.running).length;
  }

  ownsPath(pathname: string): boolean {
    return pathname.startsWith("/mcp-hub/");
  }

  async handle(request: Request): Promise<Response> {
    const [, , token, key, conversationId] = new URL(request.url).pathname.split("/");
    if (token === this.token && key === "pupitre" && conversationId && this.port !== null) {
      return this.handlePupitre(request, decodeURIComponent(conversationId), this.port());
    }
    const upstream = token === this.token && key ? this.upstreams.get(key) : undefined;
    if (!upstream) return new Response("serveur MCP inconnu", { status: 404 });
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST, DELETE" } });

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON illisible" } }, { status: 400 });
    }
    const messages = (Array.isArray(body) ? body : [body]) as JsonRpcMessage[];
    const sessionId = request.headers.get("mcp-session-id") ?? randomUUID();
    const responses = (await Promise.all(messages.map((message) =>
      this.dispatch(upstream, message, request.signal)))).filter((response): response is JsonRpcMessage => response !== null);
    const headers = { "mcp-session-id": sessionId };
    if (responses.length === 0) return new Response(null, { status: 202, headers });
    return Response.json(Array.isArray(body) ? responses : responses[0], { headers });
  }

  private async handlePupitre(request: Request, conversationId: string, port: number): Promise<Response> {
    const server = createPupitreServer({ conversationId, port });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(request);
    } finally {
      void server.close();
    }
  }

  shutdown(): void {
    for (const upstream of this.upstreams.values()) upstream.stop();
  }

  private get home(): string {
    return this.options.home ?? homedir();
  }

  private register(name: string, server: StdioServer): string {
    const key = createHash("sha256")
      .update(JSON.stringify([server.command, server.args, server.env, server.cwd]))
      .digest("hex")
      .slice(0, 24);
    if (!this.upstreams.has(key)) {
      this.upstreams.set(key, new Upstream(name, server, this.options.idleMs ?? DEFAULT_IDLE_MS, this.home));
    }
    return `http://127.0.0.1:${this.port!()}/mcp-hub/${this.token}/${key}`;
  }

  private async dispatch(upstream: Upstream, message: JsonRpcMessage, signal: AbortSignal): Promise<JsonRpcMessage | null> {
    if (typeof message?.method !== "string") return null;
    const id = message.id;
    if (id === undefined || id === null) return null;
    try {
      if (message.method === "initialize") {
        const params = message.params as { protocolVersion?: unknown } | undefined;
        const requested = typeof params?.protocolVersion === "string"
          ? params.protocolVersion
          : HUB_PROTOCOL_VERSION;
        return { jsonrpc: "2.0", id, result: await upstream.initialize(requested) };
      }
      if (message.method === "ping") return { jsonrpc: "2.0", id, result: {} };
      const response = await upstream.request(message.method, message.params, signal);
      return response.error !== undefined
        ? { jsonrpc: "2.0", id, error: response.error }
        : { jsonrpc: "2.0", id, result: response.result };
    } catch (error) {
      return { jsonrpc: "2.0", id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } };
    }
  }
}

export const mcpHub = new McpHub();
