import { test, expect, afterAll } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { runClaudeTurn } from "../src/adapters/claude";
import type { AppEvent } from "../src/events";

const FAKE = join(import.meta.dir, "fake-bins/fake-claude");

async function collect(opts: Parameters<typeof runClaudeTurn>[0]): Promise<AppEvent[]> {
  const events: AppEvent[] = [];
  await runClaudeTurn(opts, (e) => events.push(e));
  return events;
}

test("premier tour : pas de -r, événements émis, status done", async () => {
  const argsFile = join(mkdtempSync(join(tmpdir(), "pupitre-")), "args");
  const stdinFile = join(mkdtempSync(join(tmpdir(), "pupitre-")), "stdin");
  process.env.PUPITRE_CLAUDE_BIN = FAKE;
  process.env.FAKE_CLAUDE_ARGS_FILE = argsFile;
  process.env.FAKE_CLAUDE_STDIN_FILE = stdinFile;
  const events = await collect({ cwd: "/tmp", model: "opus", speed: "fast", prompt: "salut", cliSessionId: null, permissionMode: "acceptEdits", images: [] });
  const args = readFileSync(argsFile, "utf8");
  expect(args).not.toContain("-r ");
  expect(args).not.toContain("--effort");
  expect(args).not.toContain("fast_mode");
  expect(args).not.toContain("service_tier");
  expect(args).toContain("--output-format stream-json");
  expect(args).toContain("--input-format stream-json");
  expect(args).toContain("Edit(~/.claude/**)");
  expect(args).toContain("Write(~/.codex/**)");
  expect(args).toContain("Bash(npm run build:*)");
  expect(args).toContain("Bash(bun test:*)");
  expect(args).not.toContain("-- salut");
  expect(JSON.parse(readFileSync(stdinFile, "utf8"))).toMatchObject({
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "salut" }] },
  });
  expect(events.some((e) => e.type === "session")).toBe(true);
  expect((events.at(-1) as any).state).toBe("done");
});

test("ajoute --effort quand un effort est fourni", async () => {
  const argsFile = join(mkdtempSync(join(tmpdir(), "pupitre-")), "args");
  process.env.PUPITRE_CLAUDE_BIN = FAKE;
  process.env.FAKE_CLAUDE_ARGS_FILE = argsFile;
  await collect({
    cwd: "/tmp",
    model: "opus",
    effort: "xhigh",
    prompt: "analyse",
    cliSessionId: null,
    permissionMode: "acceptEdits",
    images: [],
  });

  expect(readFileSync(argsFile, "utf8")).toContain("--effort xhigh");
});

test("traduit l'ancien identifiant Fable 5 vers l'alias accepté par Claude Code", async () => {
  const argsFile = join(mkdtempSync(join(tmpdir(), "pupitre-")), "args");
  process.env.PUPITRE_CLAUDE_BIN = FAKE;
  process.env.FAKE_CLAUDE_ARGS_FILE = argsFile;
  await collect({
    cwd: "/tmp",
    model: "fable-5",
    prompt: "analyse",
    cliSessionId: null,
    permissionMode: "acceptEdits",
    images: [],
  });

  const args = readFileSync(argsFile, "utf8");
  expect(args).toContain("--model fable");
  expect(args).not.toContain("--model fable-5");
});

test("YOLO transmet le bypass dangereux à Claude", async () => {
  const argsFile = join(mkdtempSync(join(tmpdir(), "pupitre-")), "args");
  process.env.PUPITRE_CLAUDE_BIN = FAKE;
  process.env.FAKE_CLAUDE_ARGS_FILE = argsFile;
  await collect({
    cwd: "/tmp",
    model: "opus",
    prompt: "yolo",
    cliSessionId: null,
    permissionMode: "bypassPermissions",
    images: [],
  });
  const args = readFileSync(argsFile, "utf8");
  expect(args).toContain("--permission-mode bypassPermissions");
  expect(args).toContain("--dangerously-skip-permissions");
  expect(args).toContain("--add-dir /home/clement/.claude /home/clement/.codex /home/clement/.grok");
  expect(args).toContain("Edit(~/.claude/**)");
  expect(args).toContain("Write(~/.codex/**)");
  expect(args).toContain("Bash(npm run build:*)");
  expect(args).toContain("Bash(bun test:*)");
});

test("tour suivant : ajoute -r <sessionId>", async () => {
  const argsFile = join(mkdtempSync(join(tmpdir(), "pupitre-")), "args");
  process.env.PUPITRE_CLAUDE_BIN = FAKE;
  process.env.FAKE_CLAUDE_ARGS_FILE = argsFile;
  await collect({ cwd: "/tmp", model: "opus", prompt: "suite", cliSessionId: "abc-123", permissionMode: "acceptEdits", images: [] });
  expect(readFileSync(argsFile, "utf8")).toContain("-r abc-123");
});

test("conversation Pupitre : Claude autorise les outils MCP du brief et des documents", async () => {
  const argsFile = join(mkdtempSync(join(tmpdir(), "pupitre-")), "args");
  process.env.PUPITRE_CLAUDE_BIN = FAKE;
  process.env.FAKE_CLAUDE_ARGS_FILE = argsFile;
  await collect({
    cwd: "/tmp",
    model: "opus",
    prompt: "lis le brief",
    cliSessionId: null,
    permissionMode: "acceptEdits",
    images: [],
    pupitre: { port: 4820, conversationId: "conversation-1" },
  });

  expect(readFileSync(argsFile, "utf8")).toContain(
    "--allowedTools mcp__pupitre__publish_document,mcp__pupitre__publish_html_document,mcp__pupitre__read_sibling_conversation",
  );
});

test("un prompt ressemblant à une option passe par stdin", async () => {
  const argsFile = join(mkdtempSync(join(tmpdir(), "pupitre-")), "args");
  const stdinFile = join(mkdtempSync(join(tmpdir(), "pupitre-")), "stdin");
  process.env.PUPITRE_CLAUDE_BIN = FAKE;
  process.env.FAKE_CLAUDE_ARGS_FILE = argsFile;
  process.env.FAKE_CLAUDE_STDIN_FILE = stdinFile;
  await collect({ cwd: "/tmp", model: "opus", prompt: "--danger", cliSessionId: null, permissionMode: "acceptEdits", images: [] });
  expect(readFileSync(argsFile, "utf8")).not.toContain("--danger");
  expect(readFileSync(stdinFile, "utf8")).toContain('"text":"--danger"');
});

test("injecte une précision et une image dans le tour actif", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pupitre-"));
  const steerFile = join(dir, "steer");
  process.env.PUPITRE_CLAUDE_BIN = FAKE;
  process.env.FAKE_CLAUDE_HANG = "1";
  process.env.FAKE_CLAUDE_STEER_FILE = steerFile;
  let steer: import("../src/adapters/types").SteerFn | undefined;
  const turn = collect({
    cwd: "/tmp", model: "opus", prompt: "commence", cliSessionId: null,
    permissionMode: "acceptEdits", images: [],
    registerSteer: (registered) => { steer = registered; },
  });

  const deadline = Date.now() + 2_000;
  while (!steer && Date.now() < deadline) await Bun.sleep(10);
  expect(steer).toBeDefined();
  expect(await steer!({ prompt: "regarde aussi", images: ["/tmp/capture.png"] })).toBe(true);
  await turn;
  expect(JSON.parse(readFileSync(steerFile, "utf8"))).toMatchObject({
    message: { content: [{ text: expect.stringContaining("/tmp/capture.png") }] },
  });
});

test("binaire introuvable → status error, pas d'exception", async () => {
  process.env.PUPITRE_CLAUDE_BIN = "/nonexistent/claude";
  const events = await collect({ cwd: "/tmp", model: "opus", prompt: "x", cliSessionId: null, permissionMode: "acceptEdits", images: [] });
  expect((events.at(-1) as any).state).toBe("error");
});

afterAll(() => {
  delete process.env.PUPITRE_CLAUDE_BIN;
  delete process.env.FAKE_CLAUDE_ARGS_FILE;
  delete process.env.FAKE_CLAUDE_STDIN_FILE;
  delete process.env.FAKE_CLAUDE_HANG;
  delete process.env.FAKE_CLAUDE_STEER_FILE;
});
