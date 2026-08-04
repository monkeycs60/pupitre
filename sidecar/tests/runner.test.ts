import { test, expect, beforeEach } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { ProjectStore } from "../src/stores/projects";
import { ConversationStore } from "../src/stores/conversations";
import { MediaStore } from "../src/media";
import { ConversationRunner, sweepOrphanedRuns } from "../src/runner";
import type { AppEvent } from "../src/events";

let runner: ConversationRunner;
let convs: ConversationStore;
let projects: ProjectStore;
let projectId: string;
let broadcast: AppEvent[];

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "pupitre-"));
  const db = openDb(dir);
  projects = new ProjectStore(db);
  projectId = projects.create({ name: "p", path: "/tmp" }).id;
  convs = new ConversationStore(db);
  broadcast = [];
  process.env.PUPITRE_CLAUDE_BIN = join(import.meta.dir, "fake-bins/fake-claude");
  runner = new ConversationRunner(convs, projects, new MediaStore(dir),
    (_convId, event) => broadcast.push(event));
});

test("un tour persiste user-message + événements, capture le session id, diffuse en live", async () => {
  const c = convs.create({ projectId, provider: "claude", model: "haiku", firstMessage: "salut" });
  await runner.runTurn(c.id, "salut", []);
  const stored = convs.listEvents(c.id);
  expect(stored[0]).toMatchObject({ type: "user-message", text: "salut" });
  expect(stored.some((event) => event.type === "session")).toBe(true);
  expect(convs.get(c.id)!.cli_session_id).not.toBeNull();
  expect(broadcast.length).toBeGreaterThan(2);
});

test("transmet l'effort de la conversation à l'adapter", async () => {
  const argsFile = join(mkdtempSync(join(tmpdir(), "pupitre-effort-")), "args");
  process.env.FAKE_CLAUDE_ARGS_FILE = argsFile;
  const c = convs.create({
    projectId,
    provider: "claude",
    model: "haiku",
    effort: "xhigh",
    firstMessage: "analyse",
  });

  try {
    await runner.runTurn(c.id, "analyse", []);
    expect(readFileSync(argsFile, "utf8")).toContain("--effort xhigh");
  } finally {
    delete process.env.FAKE_CLAUDE_ARGS_FILE;
  }
});

test("transmet la vitesse de la conversation à l'adapter Codex", async () => {
  const argsFile = join(mkdtempSync(join(tmpdir(), "pupitre-speed-")), "args");
  const previousCodexBin = process.env.PUPITRE_CODEX_BIN;
  const previousArgsFile = process.env.FAKE_CODEX_ARGS_FILE;
  process.env.PUPITRE_CODEX_BIN = join(import.meta.dir, "fake-bins/fake-codex");
  process.env.FAKE_CODEX_ARGS_FILE = argsFile;
  const c = convs.create({
    projectId,
    provider: "codex",
    model: "gpt-5.6-luna",
    speed: "fast",
    firstMessage: "vite",
  });

  try {
    await runner.runTurn(c.id, "vite", []);
    expect(readFileSync(argsFile, "utf8")).toContain(
      '--enable fast_mode -c service_tier="fast"',
    );
  } finally {
    if (previousCodexBin === undefined) delete process.env.PUPITRE_CODEX_BIN;
    else process.env.PUPITRE_CODEX_BIN = previousCodexBin;
    if (previousArgsFile === undefined) delete process.env.FAKE_CODEX_ARGS_FILE;
    else process.env.FAKE_CODEX_ARGS_FILE = previousArgsFile;
  }
});

test("deux tours simultanés sur la même conversation → le second est refusé", async () => {
  const c = convs.create({ projectId, provider: "claude", model: "haiku", firstMessage: "x" });
  const firstTurn = runner.runTurn(c.id, "a", []);
  await expect(runner.runTurn(c.id, "b", [])).rejects.toThrow("déjà en cours");
  await firstTurn;
});

test("deux tours simultanés sur deux conversations différentes aboutissent", async () => {
  const first = convs.create({
    projectId,
    provider: "claude",
    model: "haiku",
    firstMessage: "premier",
  });
  const second = convs.create({
    projectId,
    provider: "claude",
    model: "haiku",
    firstMessage: "second",
  });

  await Promise.all([
    runner.runTurn(first.id, "premier", []),
    runner.runTurn(second.id, "second", []),
  ]);

  expect(convs.listEvents(first.id).at(-1)).toEqual({
    type: "status",
    state: "done",
  });
  expect(convs.listEvents(second.id).at(-1)).toEqual({
    type: "status",
    state: "done",
  });
});

test("le sweep marque en erreur un status running orphelin", () => {
  const c = convs.create({ projectId, provider: "claude", model: "haiku", firstMessage: "x" });
  convs.appendEvent(c.id, { type: "status", state: "running" });

  sweepOrphanedRuns(convs, projects);

  expect(convs.listEvents(c.id).at(-1)).toEqual({
    type: "status",
    state: "error",
    error: "interrompu (sidecar redémarré)",
  });
});

test("cancelTurn annule le process actif et déverrouille la conversation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pupitre-cancel-"));
  const hangingBin = join(dir, "fake-claude-hanging");
  writeFileSync(hangingBin, "#!/bin/sh\nexec sleep 30\n");
  chmodSync(hangingBin, 0o755);
  process.env.PUPITRE_CLAUDE_BIN = hangingBin;
  const c = convs.create({
    projectId,
    provider: "claude",
    model: "haiku",
    firstMessage: "x",
  });

  const turn = runner.runTurn(c.id, "bloque", []);
  expect(runner.isRunning(c.id)).toBe(true);
  expect(await runner.cancelTurn(c.id)).toBe(true);
  await turn;

  expect(runner.isRunning(c.id)).toBe(false);
  expect(convs.listEvents(c.id).at(-1)).toEqual({
    type: "status",
    state: "error",
    error: "annulé",
  });
});
