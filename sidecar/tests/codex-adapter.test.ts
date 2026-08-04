import { test, expect, afterAll } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { runCodexTurn } from "../src/adapters/codex";
import type { AppEvent } from "../src/events";

const FAKE = join(import.meta.dir, "fake-bins/fake-codex");

async function collect(opts: Parameters<typeof runCodexTurn>[0]): Promise<AppEvent[]> {
  const events: AppEvent[] = [];
  await runCodexTurn(opts, (event) => events.push(event));
  return events;
}

function useFakeCodex(): string {
  const argsFile = join(mkdtempSync(join(tmpdir(), "pupitre-")), "args");
  process.env.PUPITRE_CODEX_BIN = FAKE;
  process.env.FAKE_CODEX_ARGS_FILE = argsFile;
  return argsFile;
}

test("premier tour : exec --json avec cwd et modèle, sans resume", async () => {
  const argsFile = useFakeCodex();
  const events = await collect({
    cwd: "/tmp",
    model: "gpt-5.6-luna",
    speed: "standard",
    prompt: "salut",
    cliSessionId: null,
    permissionMode: "acceptEdits",
    images: [],
  });
  const args = readFileSync(argsFile, "utf8");
  expect(args).toContain("exec --json --skip-git-repo-check -m gpt-5.6-luna -s workspace-write");
  expect(args).not.toContain("-C"); // le cwd passe par le spawn, pas par -C
  expect(args).not.toContain("model_reasoning_effort");
  expect(args).not.toContain("fast_mode");
  expect(args).not.toContain("service_tier");
  expect(args.trimEnd().endsWith("-- salut")).toBe(true);
  expect(args).not.toContain("resume");
  expect(events.some((event) => event.type === "session")).toBe(true);
  expect(events.at(-1)).toEqual({ type: "status", state: "done" });
});

test("premier tour : active fast_mode et le service tier fast", async () => {
  const argsFile = useFakeCodex();
  await collect({
    cwd: "/tmp",
    model: "gpt-5.6-luna",
    speed: "fast",
    prompt: "vite",
    cliSessionId: null,
    permissionMode: "acceptEdits",
    images: [],
  });

  expect(readFileSync(argsFile, "utf8")).toContain(
    '--enable fast_mode -c service_tier="fast"',
  );
});

test("premier tour : ajoute model_reasoning_effort avec -c", async () => {
  const argsFile = useFakeCodex();
  await collect({
    cwd: "/tmp",
    model: "gpt-5.6-luna",
    effort: "xhigh",
    prompt: "analyse",
    cliSessionId: null,
    permissionMode: "acceptEdits",
    images: [],
  });

  expect(readFileSync(argsFile, "utf8")).toContain(
    '-c model_reasoning_effort="xhigh"',
  );
});

test("tour suivant : utilise exec resume <sessionId>", async () => {
  const argsFile = useFakeCodex();
  await collect({
    cwd: "/tmp",
    model: "gpt-5.6-luna",
    effort: "high",
    speed: "fast",
    prompt: "suite",
    cliSessionId: "abc-123",
    permissionMode: "acceptEdits",
    images: [],
  });
  const args = readFileSync(argsFile, "utf8");
  expect(args).toContain("exec resume abc-123");
  // resume ne supporte ni -C ni -s : sandbox via -c sandbox_mode (vérifié en réel)
  expect(args).not.toContain("-C");
  expect(args).not.toContain("-s workspace-write");
  expect(args).toContain('sandbox_mode="workspace-write"');
  expect(args).toContain('-c model_reasoning_effort="high"');
  expect(args).toContain('--enable fast_mode -c service_tier="fast"');
});

test("sépare un prompt ressemblant à une option avec --", async () => {
  const argsFile = useFakeCodex();
  await collect({
    cwd: "/tmp",
    model: "gpt-5.6-luna",
    prompt: "--danger",
    cliSessionId: null,
    permissionMode: "acceptEdits",
    images: [],
  });
  expect(readFileSync(argsFile, "utf8").trimEnd().endsWith("-- --danger")).toBe(true);
});

test("ajoute -i <path> pour chaque image", async () => {
  const argsFile = useFakeCodex();
  await collect({
    cwd: "/tmp",
    model: "gpt-5.6-luna",
    prompt: "décris",
    cliSessionId: null,
    permissionMode: "acceptEdits",
    images: ["/tmp/une.png", "/tmp/deux.jpg"],
  });
  const args = readFileSync(argsFile, "utf8");
  expect(args).toContain("-i /tmp/une.png");
  expect(args).toContain("-i /tmp/deux.jpg");
});

test("binaire introuvable → status error, pas d'exception", async () => {
  process.env.PUPITRE_CODEX_BIN = "/nonexistent/codex";
  const events = await collect({
    cwd: "/tmp",
    model: "gpt-5.6-luna",
    prompt: "x",
    cliSessionId: null,
    permissionMode: "acceptEdits",
    images: [],
  });
  expect(events.at(-1)?.type).toBe("status");
  expect((events.at(-1) as any).state).toBe("error");
});

afterAll(() => {
  delete process.env.PUPITRE_CODEX_BIN;
  delete process.env.FAKE_CODEX_ARGS_FILE;
});
