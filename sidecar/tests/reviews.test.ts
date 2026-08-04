import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { QuotaTracker } from "../src/quotas";
import { parseReviewOutput, ReviewRunner, splitDiffIntoZones } from "../src/reviews";
import { ConversationStore } from "../src/stores/conversations";
import { PresetStore } from "../src/stores/presets";
import { ProjectStore } from "../src/stores/projects";
import { ReviewStore } from "../src/stores/reviews";

let dir: string;
let repo: string;
let db: Database;
let projects: ProjectStore;
let conversations: ConversationStore;
let presets: PresetStore;
let store: ReviewStore;
let quotas: QuotaTracker;
const previousEnv: Record<string, string | undefined> = {};

function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: repo });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

beforeEach(() => {
  for (const key of ["PUPITRE_CODEX_BIN", "PUPITRE_CODEX_MODE"]) {
    previousEnv[key] = process.env[key];
  }
  dir = mkdtempSync(join(tmpdir(), "pupitre-reviews-"));
  repo = join(dir, "repo");
  Bun.spawnSync(["mkdir", repo]);
  git("init", "-q");
  git("config", "user.email", "gardien@example.test");
  git("config", "user.name", "Gardien Fixture");
  Bun.spawnSync(["mkdir", "-p", join(repo, "src")]);
  writeFileSync(join(repo, "src/config.ts"), "console.log('configuration prête')\n");
  git("add", ".");
  git("commit", "-qm", "base");

  db = openDb(join(dir, "data"));
  projects = new ProjectStore(db);
  conversations = new ConversationStore(db);
  presets = new PresetStore(db);
  store = new ReviewStore(db);
  quotas = new QuotaTracker(db);
});

afterEach(() => {
  db.close();
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("découpe le diff par fichiers sans passer par un modèle cheap", () => {
  const first = "diff --git a/a.ts b/a.ts\n" + "+a\n".repeat(8);
  const second = "diff --git a/b.ts b/b.ts\n" + "+b\n".repeat(8);
  expect(splitDiffIntoZones(first + second, first.length + 1)).toEqual([first, second]);
});

test("parse une sortie JSON fenced et refuse un flag hors des lignes modifiées", () => {
  const diff = [
    "diff --git a/src/config.ts b/src/config.ts",
    "--- a/src/config.ts",
    "+++ b/src/config.ts",
    "@@ -1 +1 @@",
    "-console.log('avant')",
    "+console.log(process.env.SECRET)",
  ].join("\n");
  const fixture = readFileSync(join(import.meta.dir, "fixtures/review-scan-codex.jsonl"), "utf8");
  const message = fixture.trim().split("\n")
    .map((line) => JSON.parse(line))
    .find((event) => event.item?.type === "agent_message").item.text as string;
  expect(parseReviewOutput(message, diff)).toEqual([{
    file: "src/config.ts",
    line_start: 1,
    line_end: 1,
    severity: "red",
    category: "secret/credential",
    message: "Ne journalisez pas process.env.SECRET, car sa valeur sera exposée dans les logs ; supprimez ce log ou remplacez-le par un indicateur non sensible.",
  }]);
  expect(() => parseReviewOutput(
    '{"flags":[{"file":"src/config.ts","line_start":99,"line_end":99,'
      + '"severity":"red","category":"secret","message":"hors diff"}]}',
    diff,
  )).toThrow(/non ancré/);
});

test("une ligne supprimée reste ancrable sur son ancien chemin", () => {
  const diff = [
    "diff --git a/src/guard.ts b/src/guard.ts",
    "deleted file mode 100644",
    "--- a/src/guard.ts",
    "+++ /dev/null",
    "@@ -4 +0,0 @@",
    "-throw new Error('refus')",
  ].join("\n");
  expect(parseReviewOutput(
    '{"flags":[{"file":"src/guard.ts","line_start":4,"line_end":4,'
      + '"severity":"red","category":"gestion erreur",'
      + '"message":"Rétablis le refus supprimé."}]}',
    diff,
  )).toHaveLength(1);
});

test("le scan headless rejoue la fixture via l'adapter Codex et persiste ses flags", async () => {
  writeFileSync(join(repo, "src/config.ts"), "console.log(process.env.SECRET)\n");
  git("add", ".");
  git("commit", "-qm", "head");
  const base = git("rev-parse", "HEAD^");
  const head = git("rev-parse", "HEAD");
  const argsFile = join(dir, "review-args");
  const fakeCodex = join(dir, "fake-codex-review");
  writeFileSync(fakeCodex, `#!/usr/bin/env bash
printf '%s\n' "$*" > "${argsFile}"
cat "${join(import.meta.dir, "fixtures/review-scan-codex.jsonl")}"
`);
  chmodSync(fakeCodex, 0o755);
  process.env.PUPITRE_CODEX_BIN = fakeCodex;
  process.env.PUPITRE_CODEX_MODE = "exec";

  const project = projects.create({ name: "fixture", path: repo });
  const conversation = conversations.create({
    projectId: project.id,
    provider: "codex",
    model: "gpt-5.6-luna",
    firstMessage: "modifie la configuration",
  });
  const runner = new ReviewRunner(store, projects, conversations, quotas);
  const review = runner.start({
    projectId: project.id,
    conversationId: conversation.id,
    gitRefBase: base,
    gitRefHead: head,
    provider: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
  });
  const completed = await runner.wait(review.id);

  expect(completed).toMatchObject({
    status: "done",
    git_ref_base: base,
    git_ref_head: head,
    review_provider: "codex",
    review_model: "gpt-5.6-sol",
    review_effort: "high",
  });
  expect(completed?.diff_text).toContain("+console.log(process.env.SECRET)");
  expect(completed?.flags).toHaveLength(1);
  expect(completed?.flags[0]).toMatchObject({
    file: "src/config.ts",
    line_start: 1,
    severity: "red",
    status: "open",
  });
  expect(readFileSync(argsFile, "utf8")).toContain("-s read-only");
  expect(readFileSync(argsFile, "utf8")).toContain("model_reasoning_effort=\"high\"");

  projects.setGardienMode(project.id, "bloquant");
  expect(runner.gardienStatus(project.id)).toEqual({
    mode: "bloquant",
    blocked: true,
    openRedCount: 1,
  });
  expect(runner.setFlagStatus(completed!.flags[0]!.id, "acked"))
    .toMatchObject({ status: "acked" });
  expect(runner.gardienStatus(project.id)).toEqual({
    mode: "bloquant",
    blocked: false,
    openRedCount: 0,
  });
});

test("une sortie invalide reçoit une seule relance de correction de format", async () => {
  writeFileSync(join(repo, "src/config.ts"), "console.log(process.env.SECRET)\n");
  git("add", ".");
  git("commit", "-qm", "head");
  const project = projects.create({ name: "retry", path: repo });
  const conversation = conversations.create({
    projectId: project.id,
    provider: "codex",
    model: "gpt-5.6-luna",
    firstMessage: "modifie",
  });
  const prompts: string[] = [];
  const runner = new ReviewRunner(
    store,
    projects,
    conversations,
    quotas,
    async ({ prompt }) => {
      prompts.push(prompt);
      return prompts.length === 1
        ? "pas du json"
        : '{"flags":[]}';
    },
  );
  const review = runner.start({
    projectId: project.id,
    conversationId: conversation.id,
    gitRefBase: "HEAD^",
    gitRefHead: "HEAD",
    provider: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
  });

  expect(await runner.wait(review.id)).toMatchObject({ status: "done", flags: [] });
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toContain("CORRECTION DE FORMAT");
});

test("un scan running orphelin est clôturé au redémarrage", () => {
  const project = projects.create({ name: "orphelin", path: repo });
  const conversation = conversations.create({
    projectId: project.id, provider: "codex", model: "gpt-5.6-luna", firstMessage: "x",
  });
  const review = store.create({
    projectId: project.id,
    conversationId: conversation.id,
    gitRefBase: "HEAD^",
    gitRefHead: "HEAD",
    provider: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
  });

  const reopenedStore = new ReviewStore(db);
  expect(reopenedStore.get(review.id)).toMatchObject({
    status: "error",
    error: "interrompu (sidecar redémarré)",
  });
});
