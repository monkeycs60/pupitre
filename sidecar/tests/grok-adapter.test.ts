import { test, expect, afterAll } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { runGrokTurn } from "../src/adapters/grok";
import type { AppEvent } from "../src/events";

const FAKE = join(import.meta.dir, "fake-bins/fake-grok");

async function collect(opts: Parameters<typeof runGrokTurn>[0]): Promise<AppEvent[]> {
  const events: AppEvent[] = [];
  await runGrokTurn(opts, (e) => events.push(e));
  return events;
}

afterAll(() => {
  delete process.env.PUPITRE_GROK_BIN;
  delete process.env.FAKE_GROK_ARGS_FILE;
  delete process.env.FAKE_GROK_PROMPT_FILE;
  delete process.env.PUPITRE_GROK_PLUGINS_DIR;
});

test("premier tour : prompt-file, pas de resume, events session et done", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pupitre-grok-"));
  process.env.PUPITRE_GROK_BIN = FAKE;
  process.env.FAKE_GROK_ARGS_FILE = join(dir, "args");
  process.env.FAKE_GROK_PROMPT_FILE = join(dir, "prompt");
  const events = await collect({
    cwd: "/tmp",
    model: "grok-4.6",
    prompt: "salut",
    cliSessionId: null,
    permissionMode: "acceptEdits",
    images: [],
  });
  const args = readFileSync(join(dir, "args"), "utf8");
  expect(args).toContain("--output-format streaming-messages-json");
  expect(args).toContain("--include-partial-messages");
  expect(args).toContain("--model grok-4.6");
  expect(args).not.toContain("--resume");
  expect(args).not.toContain("--effort");
  expect(args).toContain("--no-subagents");
  expect(args).not.toContain("salut");
  expect(readFileSync(join(dir, "prompt"), "utf8")).toBe("salut");
  expect(events.some((event) => event.type === "session" && event.provider === "grok")).toBe(true);
  expect((events.at(-1) as { state?: string }).state).toBe("done");
});

test("ajoute --effort et --resume", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pupitre-grok-"));
  process.env.PUPITRE_GROK_BIN = FAKE;
  process.env.FAKE_GROK_ARGS_FILE = join(dir, "args");
  await collect({
    cwd: "/tmp",
    model: "grok-4.6",
    effort: "xhigh",
    prompt: "suite",
    cliSessionId: "grok-session-1",
    permissionMode: "acceptEdits",
    images: [],
  });
  const args = readFileSync(join(dir, "args"), "utf8");
  expect(args).toContain("--effort xhigh");
  expect(args).toContain("--resume grok-session-1");
});

test("YOLO transmet always-approve, lecture seule pose le sandbox", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pupitre-grok-"));
  process.env.PUPITRE_GROK_BIN = FAKE;
  process.env.FAKE_GROK_ARGS_FILE = join(dir, "args");
  await collect({
    cwd: "/tmp",
    model: "grok-4.6",
    prompt: "yolo",
    cliSessionId: null,
    permissionMode: "bypassPermissions",
    sandboxMode: "read-only",
    images: [],
  });
  const args = readFileSync(join(dir, "args"), "utf8");
  expect(args).toContain("--permission-mode bypassPermissions");
  expect(args).toContain("--always-approve");
  expect(args).toContain("--sandbox read-only");
});

test("injecte un plugin MCP éphémère pour le pont Pupitre", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pupitre-grok-"));
  const plugins = join(dir, "plugins");
  process.env.PUPITRE_GROK_BIN = FAKE;
  process.env.FAKE_GROK_ARGS_FILE = join(dir, "args");
  process.env.PUPITRE_GROK_PLUGINS_DIR = plugins;
  await collect({
    cwd: "/tmp",
    model: "grok-4.6",
    prompt: "lis le brief",
    cliSessionId: null,
    permissionMode: "acceptEdits",
    images: [],
    pupitre: { port: 4820, conversationId: "conversation-1" },
  });
  expect(readdirSync(plugins)).toEqual([]);
  const args = readFileSync(join(dir, "args"), "utf8");
  expect(args).toContain("MCPTool(pupitre__*)");
  expect(args).not.toContain("--no-subagents");
});

test("un fil de conversation garde les sous-agents natifs, même orchestré", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pupitre-grok-"));
  process.env.PUPITRE_GROK_BIN = FAKE;
  process.env.FAKE_GROK_ARGS_FILE = join(dir, "args");
  process.env.PUPITRE_GROK_PLUGINS_DIR = join(dir, "plugins");
  await collect({
    cwd: "/tmp",
    model: "grok-4.6",
    prompt: "délègue",
    cliSessionId: null,
    permissionMode: "acceptEdits",
    images: [],
    pupitre: { port: 4820, conversationId: "conversation-1" },
    conductor: { port: 4820, conversationId: "conversation-1" },
  });
  expect(readFileSync(join(dir, "args"), "utf8")).not.toContain("--no-subagents");
});
