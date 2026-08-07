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
  process.env.PUPITRE_CLAUDE_BIN = FAKE;
  process.env.FAKE_CLAUDE_ARGS_FILE = argsFile;
  const events = await collect({ cwd: "/tmp", model: "opus", speed: "fast", prompt: "salut", cliSessionId: null, permissionMode: "acceptEdits", images: [] });
  const args = readFileSync(argsFile, "utf8");
  expect(args).not.toContain("-r ");
  expect(args).not.toContain("--effort");
  expect(args).not.toContain("fast_mode");
  expect(args).not.toContain("service_tier");
  expect(args).toContain("--output-format stream-json");
  expect(args).toContain("Edit(~/.claude/**)");
  expect(args).toContain("Write(~/.codex/**)");
  expect(args).toContain("Bash(npm run build:*)");
  expect(args).toContain("Bash(bun test:*)");
  expect(args.trimEnd().endsWith("-- salut")).toBe(true);
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
  expect(args).toContain("--add-dir /home/clement/.claude /home/clement/.codex");
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

test("sépare un prompt ressemblant à une option avec --", async () => {
  const argsFile = join(mkdtempSync(join(tmpdir(), "pupitre-")), "args");
  process.env.PUPITRE_CLAUDE_BIN = FAKE;
  process.env.FAKE_CLAUDE_ARGS_FILE = argsFile;
  await collect({ cwd: "/tmp", model: "opus", prompt: "--danger", cliSessionId: null, permissionMode: "acceptEdits", images: [] });
  expect(readFileSync(argsFile, "utf8").trimEnd().endsWith("-- --danger")).toBe(true);
});

test("binaire introuvable → status error, pas d'exception", async () => {
  process.env.PUPITRE_CLAUDE_BIN = "/nonexistent/claude";
  const events = await collect({ cwd: "/tmp", model: "opus", prompt: "x", cliSessionId: null, permissionMode: "acceptEdits", images: [] });
  expect((events.at(-1) as any).state).toBe("error");
});

afterAll(() => {
  delete process.env.PUPITRE_CLAUDE_BIN;
  delete process.env.FAKE_CLAUDE_ARGS_FILE;
});
