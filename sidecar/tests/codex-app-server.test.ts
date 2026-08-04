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
