import { test, expect, beforeEach } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { ProjectStore } from "../src/stores/projects";
import { ConversationStore } from "../src/stores/conversations";
import { MediaStore } from "../src/media";
import { ConversationRunner, sweepOrphanedRuns } from "../src/runner";
import { codexAppServer } from "../src/adapters/codex-app-server";
import { QuotaTracker } from "../src/quotas";
import type { AppEvent } from "../src/events";
import { GitProjectService } from "../src/git";
import type { Database } from "bun:sqlite";
import { SkillInventory } from "../src/skills";

let runner: ConversationRunner;
let convs: ConversationStore;
let projects: ProjectStore;
let projectId: string;
let broadcast: AppEvent[];
let db: Database;
let dataDir: string;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "pupitre-"));
  dataDir = dir;
  db = openDb(dir);
  projects = new ProjectStore(db);
  projectId = projects.create({ name: "p", path: "/tmp" }).id;
  convs = new ConversationStore(db);
  broadcast = [];
  process.env.PUPITRE_CLAUDE_BIN = join(import.meta.dir, "fake-bins/fake-claude");
  runner = new ConversationRunner(convs, projects, new MediaStore(dir),
    (_convId, event) => broadcast.push(event), new QuotaTracker(db), () => 4321);
});

test("tague tous les commits créés pendant un tour avec la conversation", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pupitre-turn-git-"));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: repo });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "turn@example.test");
  git("config", "user.name", "Turn Git");
  writeFileSync(join(repo, "base.txt"), "base\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const project = projects.create({ name: "repo", path: repo });
  const conversation = convs.create({
    projectId: project.id,
    provider: "claude",
    model: "haiku",
    firstMessage: "committe",
  });
  const fake = join(repo, "fake-claude-commit");
  const fixture = join(import.meta.dir, "fixtures/claude-basic.jsonl");
  writeFileSync(fake, `#!/usr/bin/env bash
printf 'one\n' > "$FAKE_REPO/one.txt"
git -C "$FAKE_REPO" add one.txt
git -C "$FAKE_REPO" commit -qm one
printf 'two\n' > "$FAKE_REPO/two.txt"
git -C "$FAKE_REPO" add two.txt
git -C "$FAKE_REPO" commit -qm two
cat "${fixture}"
`);
  chmodSync(fake, 0o755);
  process.env.PUPITRE_CLAUDE_BIN = fake;
  process.env.FAKE_REPO = repo;
  const gitView = new GitProjectService(db, projects);
  const trackedRunner = new ConversationRunner(
    convs,
    projects,
    new MediaStore(dataDir),
    () => {},
    new QuotaTracker(db),
    () => 4321,
    gitView,
  );

  try {
    await trackedRunner.runTurn(conversation.id, "committe deux fois", []);
    const linked = gitView.snapshot(project.id).commits.filter(
      (commit) => commit.subject === "one" || commit.subject === "two",
    );
    expect(linked).toHaveLength(2);
    expect(linked.every((commit) =>
      commit.conversations.some((item) => item.id === conversation.id),
    )).toBe(true);
  } finally {
    delete process.env.FAKE_REPO;
  }
});

test("un tour persiste user-message + événements, capture le session id, diffuse en live", async () => {
  const c = convs.create({ projectId, provider: "claude", model: "haiku", firstMessage: "salut" });
  await runner.runTurn(c.id, "salut", []);
  const stored = convs.listEvents(c.id);
  expect(stored[0]).toMatchObject({ type: "user-message", text: "salut" });
  expect(stored.some((event) => event.type === "session")).toBe(true);
  expect(convs.get(c.id)!.cli_session_id).not.toBeNull();
  expect(broadcast.length).toBeGreaterThan(2);
  const streamedDeltas = broadcast.filter((event) => event.type === "text-delta");
  const replayDeltas = stored.filter((event) => event.type === "text-delta");
  expect(streamedDeltas.length).toBeGreaterThan(replayDeltas.length);
  expect(replayDeltas.map((event) => event.text).join(""))
    .toBe(streamedDeltas.map((event) => event.text).join(""));
});

test("la surcharge conversation reste prioritaire sur l'autonomie du projet", async () => {
  const argsFile = join(dataDir, "claude-override-args");
  process.env.FAKE_CLAUDE_ARGS_FILE = argsFile;
  projects.setPermissionMode(projectId, "bypassPermissions");
  const conversation = convs.create({
    projectId,
    provider: "claude",
    model: "haiku",
    permissionMode: "plan",
    firstMessage: "priorité",
  });

  await runner.runTurn(conversation.id, "priorité", []);

  const args = readFileSync(argsFile, "utf8");
  expect(args).toContain("--permission-mode plan");
  expect(args).not.toContain("--dangerously-skip-permissions");
});

test("Claude reçoit l'autonomie héritée du projet à chaque nouveau tour", async () => {
  const argsFile = join(dataDir, "claude-inherited-args");
  process.env.FAKE_CLAUDE_ARGS_FILE = argsFile;
  projects.setPermissionMode(projectId, "dontAsk");
  const conversation = convs.create({
    projectId,
    provider: "claude",
    model: "haiku",
    permissionMode: null,
    firstMessage: "hérite",
  });

  await runner.runTurn(conversation.id, "hérite", []);
  expect(readFileSync(argsFile, "utf8")).toContain("--permission-mode dontAsk");

  projects.setPermissionMode(projectId, "bypassPermissions");
  await runner.runTurn(conversation.id, "nouveau défaut", []);
  expect(readFileSync(argsFile, "utf8")).toContain("--permission-mode bypassPermissions");
});

test("Grok reçoit l'autonomie héritée du projet", async () => {
  const argsFile = join(dataDir, "grok-inherited-args");
  process.env.PUPITRE_GROK_BIN = join(import.meta.dir, "fake-bins/fake-grok");
  process.env.FAKE_GROK_ARGS_FILE = argsFile;
  process.env.FAKE_GROK_PROMPT_FILE = join(dataDir, "grok-inherited-prompt");
  projects.setPermissionMode(projectId, "bypassPermissions");
  const conversation = convs.create({
    projectId,
    provider: "grok",
    model: "grok-4.6",
    permissionMode: null,
    firstMessage: "hérite",
  });

  await runner.runTurn(conversation.id, "hérite", []);

  const args = readFileSync(argsFile, "utf8");
  expect(args).toContain("--permission-mode bypassPermissions");
  expect(args).toContain("--always-approve");
});

test("mesure l'attente du premier retour et la durée totale du tour", async () => {
  const c = convs.create({
    projectId,
    provider: "claude",
    model: "haiku",
    firstMessage: "chronomètre",
  });

  await runner.runTurn(c.id, "chronomètre", []);

  const timings = convs.listEvents(c.id)
    .filter((event) => event.type === "turn-timing");
  expect(timings).toHaveLength(3);
  expect(timings[0]).toMatchObject({
    type: "turn-timing",
    phase: "started",
  });
  expect(timings[1]).toMatchObject({
    type: "turn-timing",
    phase: "first-response",
  });
  expect(timings[2]).toMatchObject({
    type: "turn-timing",
    phase: "completed",
  });
  if (timings[2]?.type !== "turn-timing") throw new Error("timing terminal absent");
  expect(timings[2].firstResponseAt).toBeString();
  expect(Date.parse(timings[2].completedAt ?? "")).toBeGreaterThanOrEqual(
    Date.parse(timings[2].firstResponseAt ?? ""),
  );
});

test("notifie la fin d'une tâche longue hors routine", async () => {
  const notifications: Array<{ kind: string; conversation_id: string | null }> = [];
  const notifyingRunner = new ConversationRunner(
    convs,
    projects,
    new MediaStore(dataDir),
    () => {},
    new QuotaTracker(db),
    () => 4321,
    undefined,
    undefined,
    (notification) => notifications.push(notification),
    () => 0,
  );
  const conversation = convs.create({
    projectId,
    provider: "claude",
    model: "haiku",
    orchestrator: false,
    firstMessage: "travail long",
  });

  await notifyingRunner.runTurn(conversation.id, "travail long", []);

  expect(notifications).toEqual([
    expect.objectContaining({
      kind: "long-task",
      conversation_id: conversation.id,
    }),
  ]);
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

test("injecte un prompt Codex invoqué dans un tour Claude sans altérer le message persisté", async () => {
  const home = join(dataDir, "home");
  const promptPath = join(home, ".codex/prompts/review.md");
  mkdirSync(join(home, ".codex/prompts"), { recursive: true });
  writeFileSync(promptPath, "# Review croisée\n\nInspecte les régressions.");
  const skills = new SkillInventory(db, projects, { homeDir: home });
  skills.refresh();
  const bridgedRunner = new ConversationRunner(
    convs,
    projects,
    new MediaStore(dataDir),
    (_conversationId, event) => broadcast.push(event),
    new QuotaTracker(db),
    () => 4321,
    undefined,
    skills,
  );
  const argsFile = join(dataDir, "bridge-args");
  const stdinFile = join(dataDir, "bridge-stdin");
  process.env.FAKE_CLAUDE_ARGS_FILE = argsFile;
  process.env.FAKE_CLAUDE_STDIN_FILE = stdinFile;
  const conversation = convs.create({
    projectId,
    provider: "claude",
    model: "haiku",
    firstMessage: "$review vérifie",
  });

  try {
    await bridgedRunner.runTurn(conversation.id, "$review vérifie", []);
    expect(readFileSync(stdinFile, "utf8")).toContain("Inspecte les régressions.");
    expect(convs.listEvents(conversation.id)[0]).toMatchObject({
      type: "user-message",
      text: "$review vérifie",
    });
  } finally {
    delete process.env.FAKE_CLAUDE_ARGS_FILE;
    delete process.env.FAKE_CLAUDE_STDIN_FILE;
  }
});

test("PUPITRE_CODEX_MODE=exec retombe sur l'adapter codex exec, vitesse comprise", async () => {
  const argsFile = join(mkdtempSync(join(tmpdir(), "pupitre-speed-")), "args");
  const previousCodexBin = process.env.PUPITRE_CODEX_BIN;
  const previousArgsFile = process.env.FAKE_CODEX_ARGS_FILE;
  process.env.PUPITRE_CODEX_MODE = "exec";
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
    delete process.env.PUPITRE_CODEX_MODE;
    if (previousCodexBin === undefined) delete process.env.PUPITRE_CODEX_BIN;
    else process.env.PUPITRE_CODEX_BIN = previousCodexBin;
    if (previousArgsFile === undefined) delete process.env.FAKE_CODEX_ARGS_FILE;
    else process.env.FAKE_CODEX_ARGS_FILE = previousArgsFile;
  }
});

test("provider codex par défaut : passe par l'app-server et persiste le threadId", async () => {
  const previousCodexBin = process.env.PUPITRE_CODEX_BIN;
  process.env.PUPITRE_CODEX_BIN = join(import.meta.dir, "fake-bins/fake-codex-app-server");
  const c = convs.create({
    projectId,
    provider: "codex",
    model: "gpt-5.6-luna",
    firstMessage: "salut",
  });

  try {
    await runner.runTurn(c.id, "salut", []);
    const stored = convs.listEvents(c.id);
    expect(stored.some((event) => event.type === "text-delta")).toBe(true);
    expect(stored.some((event) => event.type === "rate-limit")).toBe(true);
    expect(convs.get(c.id)!.cli_session_id).toBe("fake-thread-0001");
    expect(stored.at(-1)).toMatchObject({ type: "status", state: "done" });
  } finally {
    codexAppServer.shutdown();
    if (previousCodexBin === undefined) delete process.env.PUPITRE_CODEX_BIN;
    else process.env.PUPITRE_CODEX_BIN = previousCodexBin;
  }
});

test("oriente un tour Codex actif et persiste la précision dans le même tour", async () => {
  const previousCodexBin = process.env.PUPITRE_CODEX_BIN;
  process.env.PUPITRE_CODEX_BIN = join(import.meta.dir, "fake-bins/fake-codex-app-server");
  process.env.FAKE_APP_SERVER_HANG = "1";
  const conversation = convs.create({
    projectId,
    provider: "codex",
    model: "gpt-5.6-luna",
    firstMessage: "commence",
  });
  const turn = runner.runTurn(conversation.id, "commence", []);

  try {
    const deadline = Date.now() + 2_000;
    while (convs.get(conversation.id)?.cli_session_id === null && Date.now() < deadline) {
      await Bun.sleep(10);
    }
    expect(await runner.steerTurn(conversation.id, "j'ai oublié ce point", []))
      .toBe(true);
    expect(convs.listEvents(conversation.id)).toContainEqual(expect.objectContaining({
      type: "user-message",
      text: "j'ai oublié ce point",
      steering: true,
    }));
  } finally {
    await runner.cancelTurn(conversation.id);
    await turn;
    codexAppServer.shutdown();
    delete process.env.FAKE_APP_SERVER_HANG;
    if (previousCodexBin === undefined) delete process.env.PUPITRE_CODEX_BIN;
    else process.env.PUPITRE_CODEX_BIN = previousCodexBin;
  }
});

test("oriente un tour Claude actif et persiste la précision dans le même tour", async () => {
  const steerFile = join(dataDir, "claude-steer");
  process.env.FAKE_CLAUDE_HANG = "1";
  process.env.FAKE_CLAUDE_STEER_FILE = steerFile;
  const conversation = convs.create({
    projectId,
    provider: "claude",
    model: "haiku",
    firstMessage: "commence",
  });
  const turn = runner.runTurn(conversation.id, "commence", []);

  try {
    expect(await runner.steerTurn(conversation.id, "j'ai oublié ce point", []))
      .toBe(true);
    await turn;
    expect(readFileSync(steerFile, "utf8")).toContain("j'ai oublié ce point");
    expect(convs.listEvents(conversation.id)).toContainEqual(expect.objectContaining({
      type: "user-message",
      text: "j'ai oublié ce point",
      steering: true,
    }));
  } finally {
    delete process.env.FAKE_CLAUDE_HANG;
    delete process.env.FAKE_CLAUDE_STEER_FILE;
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

  expect(convs.listEvents(first.id).at(-1)).toMatchObject({
    type: "status",
    state: "done",
  });
  expect(convs.listEvents(second.id).at(-1)).toMatchObject({
    type: "status",
    state: "done",
  });
});

test("le sweep marque en erreur un status running orphelin", () => {
  const c = convs.create({ projectId, provider: "claude", model: "haiku", firstMessage: "x" });
  const runningId = convs.appendEvent(c.id, { type: "status", state: "running" });

  sweepOrphanedRuns(convs);

  expect(convs.listEvents(c.id).at(-1)).toMatchObject({
    id: runningId,
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
  expect(convs.listEvents(c.id).at(-1)).toMatchObject({
    type: "status",
    state: "error",
    error: "annulé",
  });
});
