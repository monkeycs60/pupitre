import { test, expect, afterEach } from "bun:test";
import { dirname, join } from "node:path";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { CodexAppServerClient, requestTimeoutMs } from "../src/adapters/codex-app-server";
import type { AppEvent } from "../src/events";
import type { TurnOptions } from "../src/adapters/types";
import type { SteerFn } from "../src/adapters/types";

const FAKE = join(import.meta.dir, "fake-bins/fake-codex-app-server");

const clients: CodexAppServerClient[] = [];

function newClient(): CodexAppServerClient {
  const client = new CodexAppServerClient(() => ["sentry", "node_repl"]);
  clients.push(client);
  return client;
}

function useFake(): { log: string; pid: string; args: string } {
  const dir = mkdtempSync(join(tmpdir(), "pupitre-appserver-"));
  process.env.PUPITRE_CODEX_BIN = FAKE;
  process.env.FAKE_APP_SERVER_LOG = join(dir, "log");
  process.env.FAKE_APP_SERVER_PID = join(dir, "pid");
  process.env.FAKE_APP_SERVER_ARGS = join(dir, "args");
  return { log: join(dir, "log"), pid: join(dir, "pid"), args: join(dir, "args") };
}

function turnOptions(overrides: Partial<TurnOptions> = {}): TurnOptions {
  return {
    cwd: "/tmp",
    model: "gpt-5.6-luna",
    prompt: "salut",
    cliSessionId: null,
    permissionMode: "acceptEdits",
    images: [],
    ...overrides,
  };
}

async function collect(
  client: CodexAppServerClient,
  overrides: Partial<TurnOptions> = {},
): Promise<AppEvent[]> {
  const events: AppEvent[] = [];
  await client.runTurn(turnOptions(overrides), (event) => events.push(event));
  return events;
}

function sentRequests(logFile: string): { method: string; params: any }[] {
  return readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((message) => typeof message.method === "string");
}

afterEach(() => {
  for (const client of clients.splice(0)) client.shutdown();
  delete process.env.PUPITRE_CODEX_BIN;
  delete process.env.FAKE_APP_SERVER_LOG;
  delete process.env.FAKE_APP_SERVER_PID;
  delete process.env.FAKE_APP_SERVER_ARGS;
  delete process.env.FAKE_APP_SERVER_HANG;
  delete process.env.FAKE_APP_SERVER_SILENT;
  delete process.env.FAKE_APP_SERVER_SLOW_MS;
  delete process.env.FAKE_APP_SERVER_SLOW_TURN_MS;
  delete process.env.FAKE_APP_SERVER_INIT_ERROR;
  delete process.env.FAKE_APP_SERVER_REJECT_CAPABILITIES;
  delete process.env.FAKE_APP_SERVER_CHILD_PID;
  delete process.env.FAKE_APP_SERVER_REJECT_FIRST_STEER;
  delete process.env.PUPITRE_APPSERVER_TIMEOUT_MS;
  delete process.env.PUPITRE_APPSERVER_IDLE_MS;
  delete process.env.PUPITRE_CODEX_USER_MCPS;
  delete process.env.PUPITRE_CODEX_MCP_POLICY;
  delete process.env.PUPITRE_CODEX_MCP_STARTUP_TIMEOUT_SEC;
});

test("borne par défaut les MCP utilisateur sans désactiver les plugins", async () => {
  const files = useFake();
  await collect(newClient());

  expect(JSON.parse(readFileSync(files.args, "utf8"))).toEqual([
    "app-server",
    "-c",
    "mcp_servers.sentry.startup_timeout_sec=5",
    "-c",
    "mcp_servers.node_repl.startup_timeout_sec=5",
  ]);
});

test("négocie l'API expérimentale pour les champs app-server utilisés par Pupitre", async () => {
  const files = useFake();
  await collect(newClient());

  const initialize = sentRequests(files.log).find((request) => request.method === "initialize");
  expect(initialize?.params.capabilities).toEqual({ experimentalApi: true });
});

test("app-server ancien : retente initialize sans capabilities et omet les champs expérimentaux", async () => {
  const files = useFake();
  process.env.FAKE_APP_SERVER_REJECT_CAPABILITIES = "1";

  const events = await collect(newClient());
  expect(events.at(-1)).toEqual({ type: "status", state: "done" });

  const inits = sentRequests(files.log).filter((request) => request.method === "initialize");
  expect(inits).toHaveLength(2);
  expect(inits[0]?.params.capabilities).toEqual({ experimentalApi: true });
  expect(inits[1]?.params.capabilities).toBeUndefined();

  // `runtimeWorkspaceRoots` est expérimental : sans l'opt-in, l'envoyer ferait
  // rejeter thread/start par le même app-server ancien.
  const start = sentRequests(files.log).find((request) => request.method === "thread/start")!;
  expect(start.params.runtimeWorkspaceRoots).toBeUndefined();
});

test("l'ancien opt-in conserve la configuration utilisateur sans borne", async () => {
  const files = useFake();
  process.env.PUPITRE_CODEX_USER_MCPS = "1";
  await collect(newClient());

  expect(JSON.parse(readFileSync(files.args, "utf8"))).toEqual(["app-server"]);
});

test("le mode full conserve la configuration utilisateur sans borne", async () => {
  const files = useFake();
  process.env.PUPITRE_CODEX_MCP_POLICY = "full";
  await collect(newClient());

  expect(JSON.parse(readFileSync(files.args, "utf8"))).toEqual(["app-server"]);
});

test("le mode off désactive explicitement plugins et MCP utilisateur", async () => {
  const files = useFake();
  process.env.PUPITRE_CODEX_MCP_POLICY = "off";
  await collect(newClient());

  expect(JSON.parse(readFileSync(files.args, "utf8"))).toEqual([
    "app-server",
    "--disable",
    "plugins",
    "-c",
    "mcp_servers.sentry.enabled=false",
    "-c",
    "mcp_servers.node_repl.enabled=false",
  ]);
});

test("le timeout de démarrage MCP est configurable", async () => {
  const files = useFake();
  process.env.PUPITRE_CODEX_MCP_STARTUP_TIMEOUT_SEC = "9";
  await collect(newClient());

  expect(JSON.parse(readFileSync(files.args, "utf8"))).toEqual([
    "app-server",
    "-c",
    "mcp_servers.sentry.startup_timeout_sec=9",
    "-c",
    "mcp_servers.node_repl.startup_timeout_sec=9",
  ]);
});

test("un thread orchestrateur conserve les bornes MCP en ajoutant conductor", async () => {
  const files = useFake();
  await collect(newClient(), {
    conductor: { port: 4820, conversationId: "conversation-parent" },
  });

  const start = sentRequests(files.log).find((request) => request.method === "thread/start")!;
  expect(start.params.config.mcp_servers).toMatchObject({
    sentry: { startup_timeout_sec: 5 },
    node_repl: { startup_timeout_sec: 5 },
    conductor: {
      enabled: true,
      env: {
        PUPITRE_PORT: "4820",
        PUPITRE_CONVERSATION_ID: "conversation-parent",
      },
    },
  });
});

test("le mode off reste appliqué dans un thread orchestrateur", async () => {
  const files = useFake();
  process.env.PUPITRE_CODEX_MCP_POLICY = "off";
  await collect(newClient(), {
    conductor: { port: 4820, conversationId: "conversation-parent" },
  });

  const start = sentRequests(files.log).find((request) => request.method === "thread/start")!;
  expect(start.params.config.mcp_servers).toMatchObject({
    sentry: { enabled: false },
    node_repl: { enabled: false },
    conductor: { enabled: true },
  });
});

test("une politique MCP invalide termine le tour en erreur", async () => {
  useFake();
  process.env.PUPITRE_CODEX_MCP_POLICY = "lent";
  const events = await collect(newClient());

  expect(events.at(-1)).toMatchObject({
    type: "status",
    state: "error",
    error: expect.stringContaining("PUPITRE_CODEX_MCP_POLICY invalide"),
  });
});

test("premier tour : session avec le threadId, deltas dans l'ordre, tool + usage, done", async () => {
  const files = useFake();
  const events = await collect(newClient(), { effort: "high", speed: "fast" });

  expect(events[0]).toEqual({ type: "status", state: "running" });
  expect(events[1]).toEqual({
    type: "session",
    provider: "codex",
    cliSessionId: "fake-thread-0001",
    model: "gpt-5.6-luna",
  });

  const deltas = events.filter((e) => e.type === "text-delta").map((e: any) => e.text);
  expect(deltas.slice(0, 4)).toEqual(["SPI", "KE", " OK", "."]);
  expect(deltas.join("")).toContain("SPIKE OK.\n\nhello");

  const finals = events.filter((e) => e.type === "text-final").map((e: any) => e.text);
  expect(finals.at(-1)).toBe("SPIKE OK.\n\nhello");

  const toolStart = events.find((e) => e.type === "tool-start") as any;
  expect(toolStart.toolName).toBe("shell");
  expect(toolStart.input.command).toContain("demo.txt");
  const toolEnd = events.find((e) => e.type === "tool-end") as any;
  expect(toolEnd.toolId).toBe(toolStart.toolId);
  expect(toolEnd.output).toBe("hello\n");

  const usage = events.filter((e) => e.type === "usage") as any[];
  expect(usage.at(-1)).toMatchObject({
    inputTokens: 17339,
    outputTokens: 55,
    contextTokens: 17394,
    contextWindowTokens: 258400,
  });

  expect(events.at(-1)).toEqual({ type: "status", state: "done" });

  // Les items non pertinents (userMessage, reasoning) ne produisent rien.
  expect(events.some((e) => (e as any).toolName === "reasoning")).toBe(false);

  const requests = sentRequests(files.log);
  const start = requests.find((r) => r.method === "thread/start")!;
  expect(start.params).toMatchObject({
    model: "gpt-5.6-luna",
    cwd: "/tmp",
    approvalPolicy: "never",
    sandbox: "workspace-write",
    serviceTier: "fast",
  });
  expect(start.params.runtimeWorkspaceRoots).toContain("/tmp");
  expect(start.params.runtimeWorkspaceRoots).toContain("/home/clement/.claude");
  expect(start.params.runtimeWorkspaceRoots).toContain("/home/clement/.codex");
  expect(start.params.runtimeWorkspaceRoots).toContain("/home/clement/.grok");
  // Aucune racine supplémentaire n'est demandée hors worktree.
  expect(start.params.runtimeWorkspaceRoots).toHaveLength(4);
  const turnStart = requests.find((r) => r.method === "turn/start")!;
  expect(turnStart.params).toMatchObject({ threadId: "fake-thread-0001", effort: "high" });
  expect(turnStart.params.input[0]).toEqual({ type: "text", text: "salut" });
});

test("full-system : le thread Codex passe en danger-full-access", async () => {
  const files = useFake();
  await collect(newClient(), { filesystemScope: "full-system" });
  const start = sentRequests(files.log).find((r) => r.method === "thread/start")!;
  expect(start.params).toMatchObject({
    sandbox: "danger-full-access",
  });
  expect(start.params.runtimeWorkspaceRoots).toBeUndefined();
});

test("images jointes : passées en localImage dans l'input du tour", async () => {
  const files = useFake();
  await collect(newClient(), { images: ["/tmp/une.png"] });

  const turnStart = sentRequests(files.log).find((r) => r.method === "turn/start")!;
  expect(turnStart.params.input[1]).toEqual({ type: "localImage", path: "/tmp/une.png" });
});

test("turn/steer ajoute texte et image au tour actif avec son expectedTurnId", async () => {
  const files = useFake();
  process.env.FAKE_APP_SERVER_HANG = "1";
  const controller = new AbortController();
  let steer: SteerFn | null = null;
  const client = newClient();
  const turn = client.runTurn(turnOptions({
    signal: controller.signal,
    registerSteer: (registered) => { steer = registered; },
  }), () => {});

  const deadline = Date.now() + 2_000;
  while (steer === null && Date.now() < deadline) await Bun.sleep(10);
  expect(steer).not.toBeNull();
  expect(await steer!({ prompt: "regarde plutôt ceci", images: ["/tmp/capture.png"] }))
    .toBe(true);

  const request = sentRequests(files.log).find((item) => item.method === "turn/steer")!;
  expect(request.params).toEqual({
    threadId: "fake-thread-0001",
    expectedTurnId: "fake-turn-0001",
    input: [
      { type: "text", text: "regarde plutôt ceci" },
      { type: "localImage", path: "/tmp/capture.png" },
    ],
  });

  controller.abort();
  await turn;
});

test("turn/steer rejoué après le rejet transitoire du démarrage", async () => {
  const files = useFake();
  process.env.FAKE_APP_SERVER_HANG = "1";
  process.env.FAKE_APP_SERVER_REJECT_FIRST_STEER = "1";
  const controller = new AbortController();
  let steer: SteerFn | null = null;
  const client = newClient();
  const turn = client.runTurn(turnOptions({
    signal: controller.signal,
    registerSteer: (registered) => { steer = registered; },
  }), () => {});

  const deadline = Date.now() + 2_000;
  while (steer === null && Date.now() < deadline) await Bun.sleep(10);
  expect(await steer!({ prompt: "précision immédiate", images: [] })).toBe(true);
  expect(sentRequests(files.log).filter((item) => item.method === "turn/steer"))
    .toHaveLength(2);

  controller.abort();
  await turn;
});

test("un cliSessionId présent déclenche thread/resume, pas thread/start", async () => {
  const files = useFake();
  const events = await collect(newClient(), { cliSessionId: "thread-abc" });

  const requests = sentRequests(files.log);
  expect(requests.some((r) => r.method === "thread/start")).toBe(false);
  const resume = requests.find((r) => r.method === "thread/resume")!;
  expect(resume.params).toMatchObject({ threadId: "thread-abc", cwd: "/tmp" });
  expect(events.find((e) => e.type === "session")).toMatchObject({
    cliSessionId: "thread-abc",
  });
  expect(events.at(-1)).toEqual({ type: "status", state: "done" });
});

test("un thread fast repris en standard réinitialise explicitement le service tier", async () => {
  const files = useFake();
  await collect(newClient(), {
    cliSessionId: "thread-fast",
    speed: "standard",
  });

  const requests = sentRequests(files.log);
  expect(requests.find((request) => request.method === "thread/resume")?.params.serviceTier)
    .toBeNull();
  expect(requests.find((request) => request.method === "turn/start")?.params.serviceTier)
    .toBeNull();
});

test("account/rateLimits/updated devient un event rate-limit", async () => {
  useFake();
  const events = await collect(newClient());

  const rateLimits = events.filter((e) => e.type === "rate-limit") as any[];
  expect(rateLimits.length).toBeGreaterThan(0);
  expect(rateLimits[0].provider).toBe("codex");
  expect(rateLimits[0].payload.primary).toMatchObject({
    usedPercent: 10,
    windowDurationMins: 10080,
  });
});

test("le process est partagé entre deux tours puis relancé s'il meurt", async () => {
  const files = useFake();
  const client = newClient();

  await collect(client);
  const firstPid = Number(readFileSync(files.pid, "utf8"));
  await collect(client);
  expect(Number(readFileSync(files.pid, "utf8"))).toBe(firstPid); // même process

  process.kill(firstPid, "SIGKILL");
  await Bun.sleep(50);

  const events = await collect(client);
  const secondPid = Number(readFileSync(files.pid, "utf8"));
  expect(secondPid).not.toBe(firstPid); // process relancé
  expect(events.at(-1)).toEqual({ type: "status", state: "done" });
});

test("le watchdog arrête l'app-server inactif puis le relance au tour suivant", async () => {
  const files = useFake();
  process.env.PUPITRE_APPSERVER_IDLE_MS = "50";
  const client = newClient();

  await collect(client);
  const firstPid = Number(readFileSync(files.pid, "utf8"));

  await Bun.sleep(120);
  expect(() => process.kill(firstPid, 0)).toThrow();

  const events = await collect(client);
  const secondPid = Number(readFileSync(files.pid, "utf8"));
  expect(secondPid).not.toBe(firstPid);
  expect(events.at(-1)).toEqual({ type: "status", state: "done" });
});

test("un process qui meurt pendant un tour termine le tour en erreur", async () => {
  const files = useFake();
  process.env.FAKE_APP_SERVER_HANG = "1";
  const client = newClient();

  const events: AppEvent[] = [];
  const turn = client.runTurn(turnOptions(), (event) => events.push(event));
  await Bun.sleep(300);
  process.kill(Number(readFileSync(files.pid, "utf8")), "SIGKILL");
  await turn;

  expect(events.at(-1)).toMatchObject({ type: "status", state: "error" });
});

test("annulation : envoie turn/interrupt et termine en erreur « annulé »", async () => {
  const files = useFake();
  process.env.FAKE_APP_SERVER_HANG = "1";
  const controller = new AbortController();
  const client = newClient();

  const events: AppEvent[] = [];
  const turn = client.runTurn(
    turnOptions({ signal: controller.signal }),
    (event) => events.push(event),
  );
  await Bun.sleep(300);
  expect(events.some((e) => e.type === "text-delta")).toBe(true);
  controller.abort();
  await turn;

  expect(events.at(-1)).toEqual({ type: "status", state: "error", error: "annulé" });
  // L'interruption part en fire-and-forget : on laisse le fake la journaliser.
  await Bun.sleep(100);
  const interrupt = sentRequests(files.log).find((r) => r.method === "turn/interrupt")!;
  expect(interrupt.params).toMatchObject({ threadId: "fake-thread-0001" });
  expect(typeof interrupt.params.turnId).toBe("string");
});

test("signal déjà annulé avant le tour : aucun process lancé", async () => {
  useFake();
  const controller = new AbortController();
  controller.abort();
  const events = await collect(newClient(), { signal: controller.signal });

  expect(events).toEqual([
    { type: "status", state: "running" },
    { type: "status", state: "error", error: "annulé" },
  ]);
});

test("binaire introuvable → status error, pas d'exception", async () => {
  process.env.PUPITRE_CODEX_BIN = "/nonexistent/codex";
  const events = await collect(newClient());

  expect(events.at(-1)).toMatchObject({ type: "status", state: "error" });
});

test("shutdown pendant un tour : le tour est résolu en erreur, pas suspendu", async () => {
  useFake();
  process.env.FAKE_APP_SERVER_HANG = "1";
  const client = newClient();

  const events: AppEvent[] = [];
  const turn = client.runTurn(turnOptions(), (event) => events.push(event));
  await Bun.sleep(200);
  expect(events.some((e) => e.type === "text-delta")).toBe(true);

  client.shutdown();
  // Sans le cleanup dans shutdown(), ce await ne se résoudrait jamais.
  await Promise.race([turn, Bun.sleep(2000).then(() => Promise.reject(new Error("tour suspendu")))]);

  expect(events.at(-1)).toMatchObject({ type: "status", state: "error" });
});

test("requête JSON-RPC sans réponse : timeout → status error", async () => {
  useFake();
  process.env.FAKE_APP_SERVER_SILENT = "turn/start";
  process.env.PUPITRE_APPSERVER_TIMEOUT_MS = "200";

  const events = await collect(newClient());

  const last = events.at(-1) as any;
  expect(last).toMatchObject({ type: "status", state: "error" });
  expect(last.error).toContain("timeout turn/start");
});

test("annulation pendant le setup (thread/start lent) : status error « annulé », pas de tour lancé", async () => {
  const files = useFake();
  process.env.FAKE_APP_SERVER_SLOW_MS = "300";
  const controller = new AbortController();

  const events: AppEvent[] = [];
  const turn = newClient().runTurn(
    turnOptions({ signal: controller.signal }),
    (event) => events.push(event),
  );
  await Bun.sleep(100);
  controller.abort();
  await turn;

  expect(events.at(-1)).toEqual({ type: "status", state: "error", error: "annulé" });
  expect(events.some((e) => e.type === "session")).toBe(false);
  await Bun.sleep(400);
  expect(sentRequests(files.log).some((r) => r.method === "turn/start")).toBe(false);
});

test("annulation pendant la réponse à turn/start : interrompt le tour dès que son id arrive", async () => {
  const files = useFake();
  process.env.FAKE_APP_SERVER_SLOW_TURN_MS = "300";
  process.env.FAKE_APP_SERVER_HANG = "1";
  const controller = new AbortController();

  const events: AppEvent[] = [];
  const turn = newClient().runTurn(
    turnOptions({ signal: controller.signal }),
    (event) => events.push(event),
  );
  await Bun.sleep(100);
  controller.abort();
  await turn;

  expect(events.at(-1)).toEqual({ type: "status", state: "error", error: "annulé" });
  await Bun.sleep(350);
  const requests = sentRequests(files.log);
  expect(requests.filter((request) => request.method === "turn/interrupt")).toHaveLength(1);
  expect(requests.find((request) => request.method === "turn/interrupt")?.params)
    .toMatchObject({ threadId: "fake-thread-0001", turnId: "fake-turn-0001" });
});

test("multiplexage : deux tours concurrents ne reçoivent chacun que leurs deltas", async () => {
  useFake();
  // Référence : le flux exact d'un tour seul, sur son propre process.
  const solo = await collect(newClient());
  const text = (events: AppEvent[]) =>
    events.filter((e) => e.type === "text-delta").map((e: any) => e.text).join("");
  const count = (events: AppEvent[], type: string) =>
    events.filter((e) => e.type === type).length;

  const client = newClient();
  const first: AppEvent[] = [];
  const second: AppEvent[] = [];
  await Promise.all([
    client.runTurn(turnOptions({ prompt: "un" }), (event) => first.push(event)),
    client.runTurn(turnOptions({ prompt: "deux" }), (event) => second.push(event)),
  ]);

  const sessions = [first, second].map((events) => events.find((e) => e.type === "session") as any);
  expect(sessions[0].cliSessionId).toBe("fake-thread-0001");
  expect(sessions[1].cliSessionId).toBe("fake-thread-0002");

  for (const events of [first, second]) {
    // Exactement le flux d'UN tour : un mélange se verrait en doublons.
    expect(text(events)).toBe(text(solo));
    expect(count(events, "text-final")).toBe(count(solo, "text-final"));
    expect(count(events, "tool-start")).toBe(count(solo, "tool-start"));
    expect(events.at(-1)).toEqual({ type: "status", state: "done" });
  }
});

test("deux tours sur le même thread : le second termine en erreur explicite", async () => {
  useFake();
  process.env.FAKE_APP_SERVER_HANG = "1";
  const client = newClient();
  const controller = new AbortController();

  const first: AppEvent[] = [];
  const firstTurn = client.runTurn(
    turnOptions({ cliSessionId: "thread-abc", signal: controller.signal }),
    (event) => first.push(event),
  );
  await Bun.sleep(200);

  const second = await collect(client, { cliSessionId: "thread-abc" });
  expect(second.at(-1)).toMatchObject({
    type: "status",
    state: "error",
    error: expect.stringContaining("déjà actif"),
  });
  expect(second.some((e) => e.type === "session")).toBe(false);
  // Le premier tour n'a pas été perturbé.
  expect(first.some((e) => e.type === "text-delta")).toBe(true);

  controller.abort();
  await firstTurn;
});

test("shutdown tue aussi les serveurs MCP enfants de l'app-server", async () => {
  const files = useFake();
  const childPidFile = join(dirname(files.pid), "child-pid");
  process.env.FAKE_APP_SERVER_CHILD_PID = childPidFile;
  const client = newClient();

  await collect(client);
  const childPid = Number(readFileSync(childPidFile, "utf8"));
  expect(() => process.kill(childPid, 0)).not.toThrow(); // l'enfant MCP tourne

  client.shutdown();
  await Bun.sleep(200);
  // Sans kill du groupe de process, l'enfant survivrait orphelin (le bloat
  // observé : des dizaines de serveurs MCP npx accumulés au fil des sessions).
  expect(() => process.kill(childPid, 0)).toThrow();
});

test("le watchdog d'inactivité tue aussi les serveurs MCP enfants", async () => {
  const files = useFake();
  const childPidFile = join(dirname(files.pid), "child-pid");
  process.env.FAKE_APP_SERVER_CHILD_PID = childPidFile;
  process.env.PUPITRE_APPSERVER_IDLE_MS = "50";
  const client = newClient();

  await collect(client);
  const childPid = Number(readFileSync(childPidFile, "utf8"));

  await Bun.sleep(200);
  expect(() => process.kill(childPid, 0)).toThrow();
});

test("handshake initialize en erreur : status error et pas de process orphelin", async () => {
  const files = useFake();
  process.env.FAKE_APP_SERVER_INIT_ERROR = "1";

  const events = await collect(newClient());
  expect(events.at(-1)).toMatchObject({ type: "status", state: "error" });

  const pid = Number(readFileSync(files.pid, "utf8"));
  await Bun.sleep(200);
  expect(() => process.kill(pid, 0)).toThrow(); // ESRCH : le process a bien été tué
});

test("depuis un worktree, le dépôt principal reste accessible au bac à sable", async () => {
  // Le `.git` d'un worktree est un fichier « gitdir: <dépôt>/.git/worktrees/… » :
  // sans le dépôt dans les racines, toute commande git y échoue.
  const files = useFake();
  await collect(newClient(), {
    cwd: "/tmp/worktree",
    extraWorkspaceRoots: ["/depot/principal"],
  });

  const start = sentRequests(files.log).find((r) => r.method === "thread/start")!;
  expect(start.params.runtimeWorkspaceRoots).toContain("/tmp/worktree");
  expect(start.params.runtimeWorkspaceRoots).toContain("/depot/principal");
});

test("l'ouverture d'un thread a un budget plus large que les autres requêtes", () => {
  // `thread/start` démarre les serveurs MCP du thread : mesuré à 32 s sur un
  // poste réel, soit plus que le budget d'une requête ordinaire. Le tour
  // échouait alors que codex répondait, simplement plus lentement.
  expect(requestTimeoutMs("thread/start")).toBeGreaterThan(requestTimeoutMs("turn/start"));
  expect(requestTimeoutMs("thread/resume")).toBe(requestTimeoutMs("thread/start"));
  expect(requestTimeoutMs("thread/start")).toBeGreaterThanOrEqual(120_000);
});

test("les deux budgets restent réglables par variable d'environnement", () => {
  const previous = process.env.PUPITRE_APPSERVER_TIMEOUT_MS;
  const previousStart = process.env.PUPITRE_APPSERVER_START_TIMEOUT_MS;
  try {
    process.env.PUPITRE_APPSERVER_TIMEOUT_MS = "1234";
    process.env.PUPITRE_APPSERVER_START_TIMEOUT_MS = "5678";
    expect(requestTimeoutMs("turn/start")).toBe(1234);
    expect(requestTimeoutMs("thread/start")).toBe(5678);
  } finally {
    if (previous === undefined) delete process.env.PUPITRE_APPSERVER_TIMEOUT_MS;
    else process.env.PUPITRE_APPSERVER_TIMEOUT_MS = previous;
    if (previousStart === undefined) delete process.env.PUPITRE_APPSERVER_START_TIMEOUT_MS;
    else process.env.PUPITRE_APPSERVER_START_TIMEOUT_MS = previousStart;
  }
});
