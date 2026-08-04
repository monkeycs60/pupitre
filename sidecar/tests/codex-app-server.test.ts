import { test, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { CodexAppServerClient } from "../src/adapters/codex-app-server";
import type { AppEvent } from "../src/events";
import type { TurnOptions } from "../src/adapters/types";

const FAKE = join(import.meta.dir, "fake-bins/fake-codex-app-server");

const clients: CodexAppServerClient[] = [];

function newClient(): CodexAppServerClient {
  const client = new CodexAppServerClient();
  clients.push(client);
  return client;
}

function useFake(): { log: string; pid: string } {
  const dir = mkdtempSync(join(tmpdir(), "pupitre-appserver-"));
  process.env.PUPITRE_CODEX_BIN = FAKE;
  process.env.FAKE_APP_SERVER_LOG = join(dir, "log");
  process.env.FAKE_APP_SERVER_PID = join(dir, "pid");
  return { log: join(dir, "log"), pid: join(dir, "pid") };
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
  delete process.env.FAKE_APP_SERVER_HANG;
  delete process.env.FAKE_APP_SERVER_SILENT;
  delete process.env.FAKE_APP_SERVER_SLOW_MS;
  delete process.env.FAKE_APP_SERVER_SLOW_TURN_MS;
  delete process.env.FAKE_APP_SERVER_INIT_ERROR;
  delete process.env.PUPITRE_APPSERVER_TIMEOUT_MS;
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
  expect(usage.at(-1)).toMatchObject({ inputTokens: 17339, outputTokens: 55 });

  expect(events.at(-1)).toEqual({ type: "status", state: "done" });

  // Les items non pertinents (userMessage, reasoning) ne produisent rien.
  expect(events.some((e) => (e as any).toolName === "reasoning")).toBe(false);

  const requests = sentRequests(files.log);
  const start = requests.find((r) => r.method === "thread/start")!;
  expect(start.params).toMatchObject({
    model: "gpt-5.6-luna",
    cwd: "/tmp",
    approvalPolicy: "never",
    serviceTier: "fast",
  });
  const turnStart = requests.find((r) => r.method === "turn/start")!;
  expect(turnStart.params).toMatchObject({ threadId: "fake-thread-0001", effort: "high" });
  expect(turnStart.params.input[0]).toEqual({ type: "text", text: "salut" });
});

test("images jointes : passées en localImage dans l'input du tour", async () => {
  const files = useFake();
  await collect(newClient(), { images: ["/tmp/une.png"] });

  const turnStart = sentRequests(files.log).find((r) => r.method === "turn/start")!;
  expect(turnStart.params.input[1]).toEqual({ type: "localImage", path: "/tmp/une.png" });
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

test("handshake initialize en erreur : status error et pas de process orphelin", async () => {
  const files = useFake();
  process.env.FAKE_APP_SERVER_INIT_ERROR = "1";

  const events = await collect(newClient());
  expect(events.at(-1)).toMatchObject({ type: "status", state: "error" });

  const pid = Number(readFileSync(files.pid, "utf8"));
  await Bun.sleep(200);
  expect(() => process.kill(pid, 0)).toThrow(); // ESRCH : le process a bien été tué
});
