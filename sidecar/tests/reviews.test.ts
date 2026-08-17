import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { QuotaTracker } from "../src/quotas";
import {
  dispatchAgentConfig,
  parseReviewOutput,
  ReviewRunner,
  splitDiffIntoZones,
  hunkHashFor,
  type CorrectionAgentConfig,
} from "../src/reviews";
import { ConversationStore } from "../src/stores/conversations";
import { PresetStore } from "../src/stores/presets";
import { ProjectStore } from "../src/stores/projects";
import { ReviewStore } from "../src/stores/reviews";
import { SubtaskLimitError } from "../src/subtasks";
import type { Subtask, SubtaskInput, SubtaskResult } from "../src/subtasks";

let dir: string;
let repo: string;
let db: Database;
let projects: ProjectStore;
let conversations: ConversationStore;
let presets: PresetStore;
let store: ReviewStore;
let quotas: QuotaTracker;
const previousEnv: Record<string, string | undefined> = {};

test("le modèle de correction suit le provider de la conversation, pas celui du reviewer", () => {
  expect(dispatchAgentConfig({
    provider: "codex", model: "gpt-5.6-luna", effort: "xhigh", speed: "fast",
  }, "codex")).toEqual({
    provider: "codex", model: "gpt-5.6-luna", effort: "xhigh", speed: "fast",
  });
  expect(dispatchAgentConfig({
    provider: "claude", model: "fable-5", effort: "max", speed: null,
  }, "claude")).toEqual({
    provider: "claude", model: "fable-5", effort: "max", speed: null,
  });
});

function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: repo });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

/**
 * La fin d'un dispatch relance toujours une review incrémentale (tâche 3).
 * Sans l'attendre explicitement, son `execute()` continue en tâche de fond
 * après la fin du test et peut écrire sur la base fermée par `afterEach`.
 */
async function settleRescan(runner: ReviewRunner, projectId: string, originalReviewId: string): Promise<void> {
  const rescan = runner.listByProject(projectId).find((item) => item.id !== originalReviewId);
  if (rescan) await runner.wait(rescan.id);
}

beforeEach(() => {
  for (const key of [
    "PUPITRE_CODEX_BIN",
    "PUPITRE_CODEX_MODE",
    "PUPITRE_REVIEW_DIFF_MAX_BYTES",
    "PATH",
  ]) {
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

test("découpe aussi un hunk unique sans jamais dépasser la limite", () => {
  const diff = [
    "diff --git a/src/large.ts b/src/large.ts",
    "--- a/src/large.ts",
    "+++ b/src/large.ts",
    "@@ -1,120 +1,120 @@",
    ...Array.from({ length: 120 }, (_, index) => `-ancienne ligne ${index}`),
    ...Array.from({ length: 120 }, (_, index) => `+nouvelle ligne ${index}`),
  ].join("\n");
  const zones = splitDiffIntoZones(diff, 600);

  expect(zones.length).toBeGreaterThan(1);
  expect(zones.every((zone) => zone.length <= 600)).toBe(true);
  expect(zones.every((zone) => zone.startsWith("diff --git a/src/large.ts"))).toBe(true);
});

test("un flag porte les statuts et champs de dispatch", () => {
  const project = projects.create({ name: "statuts", path: repo });
  const conversation = conversations.create({
    projectId: project.id, provider: "codex", model: "gpt-5.6-luna", firstMessage: "x",
  });
  const review = store.create({
    projectId: project.id, conversationId: conversation.id, gitRefBase: "base", gitRefHead: "head",
    provider: "codex", model: "gpt-5.6-sol", effort: "high",
  });
  store.complete(review.id, [{
    file: "src/config.ts", line_start: 1, line_end: 1, severity: "red",
    category: "secret", message: "Ne journalise pas le secret.",
  }]);
  const flag = store.get(review.id)!.flags[0]!;
  expect(flag).toMatchObject({ status: "open", hunk_hash: null, subtask_id: null, user_message: null });
  expect(store.setFlagStatus(flag.id, "treated")?.status).toBe("treated");
  expect(store.setFlagStatus(flag.id, "agent_running")?.status).toBe("agent_running");
  expect(store.setFlagStatus(flag.id, "resolved")?.status).toBe("resolved");
  expect(store.setFlagStatus(flag.id, "ignored")?.status).toBe("ignored");
});

test("le hash de hunk est stable et distingue les hunks", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts",
    "@@ -1 +1 @@", "-a", "+b", "@@ -10 +10 @@", "-c", "+d",
  ].join("\n");
  expect(hunkHashFor(diff, "src/a.ts", 1)).toBe(hunkHashFor(diff, "src/a.ts", 1));
  expect(hunkHashFor(diff, "src/a.ts", 1)).not.toBe(hunkHashFor(diff, "src/a.ts", 10));
});

test("le hash de hunk conserve le chemin ancien d'un fichier supprimé", () => {
  const diff = [
    "diff --git a/src/deleted.ts b/src/deleted.ts", "deleted file mode 100644",
    "--- a/src/deleted.ts", "+++ /dev/null", "@@ -4 +0,0 @@", "-throw new Error('refus')",
  ].join("\n");
  expect(hunkHashFor(diff, "src/deleted.ts", 4)).toMatch(/^[a-f0-9]{40}$/);
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

test("le contenu qui ressemble à un en-tête de patch ne décale pas l'ancrage", () => {
  // Suppression d'un front-matter Markdown : les lignes `---` supprimées
  // arrivent dans le patch sous la forme `----`.
  const diff = [
    "diff --git a/docs/note.md b/docs/note.md",
    "--- a/docs/note.md",
    "+++ b/docs/note.md",
    "@@ -1,4 +1 @@",
    "----",
    "-titre: ancien",
    "----",
    "-contenu",
    "+contenu réécrit",
  ].join("\n");

  expect(parseReviewOutput(
    '{"flags":[{"file":"docs/note.md","line_start":1,"line_end":1,'
      + '"severity":"orange","category":"contrat",'
      + '"message":"Le front-matter supprimé casse le rendu."}]}',
    diff,
  )).toHaveLength(1);
});

test("un commentaire supprimé en `-- chemin` ne fait pas échouer la review", () => {
  const diff = [
    "diff --git a/db/migration.sql b/db/migration.sql",
    "--- a/db/migration.sql",
    "+++ b/db/migration.sql",
    "@@ -1,2 +1,2 @@",
    "--- /usr/local/share/ancienne-migration.sql",
    "+-- migration/nouvelle.sql",
    " SELECT 1;",
  ].join("\n");

  expect(parseReviewOutput(
    '{"flags":[{"file":"db/migration.sql","line_start":1,"line_end":1,'
      + '"severity":"grey","category":"lisibilité",'
      + '"message":"Documente la migration référencée."}]}',
    diff,
  )).toHaveLength(1);
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

test("un test_gap structuré ne dépend pas du vocabulaire de la catégorie", () => {
  const diff = [
    "diff --git a/src/api.ts b/src/api.ts",
    "--- a/src/api.ts",
    "+++ b/src/api.ts",
    "@@ -1 +1 @@",
    "-return oldValue",
    "+return newValue",
  ].join("\n");

  expect(parseReviewOutput(JSON.stringify({ flags: [{
    file: "src/api.ts",
    line_start: 1,
    line_end: 1,
    severity: "orange",
    category: "test coverage",
    message: "Add an automated regression for the new response.",
    test_gap: true,
  }] }), diff)[0]?.test_gap).toBe(true);
});

test("migre les anciennes alertes de tests vers le marqueur structuré", () => {
  const legacyDir = mkdtempSync(join(tmpdir(), "pupitre-review-gap-migration-"));
  const legacyDb = new Database(join(legacyDir, "pupitre.db"));
  legacyDb.exec(`
    CREATE TABLE review_flags (
      id TEXT PRIMARY KEY,
      review_id TEXT NOT NULL,
      file TEXT NOT NULL,
      line_start INTEGER NOT NULL,
      line_end INTEGER NOT NULL,
      severity TEXT NOT NULL,
      category TEXT NOT NULL,
      message TEXT NOT NULL,
      code_provider TEXT NULL,
      status TEXT NOT NULL DEFAULT 'open'
    );
    INSERT INTO review_flags
      (id, review_id, file, line_start, line_end, severity, category, message, status)
    VALUES
      ('legacy-gap', 'review', 'src/api.ts', 1, 1, 'orange',
       'absence de test', 'Ajoute une régression automatisée.', 'open'),
      ('legacy-other', 'review', 'src/api.ts', 2, 2, 'grey',
       'lisibilité', 'Renomme cette variable.', 'open');
  `);
  legacyDb.close();

  const migrated = openDb(legacyDir);
  expect(migrated.query(
    "SELECT id, is_test_gap FROM review_flags ORDER BY id",
  ).all()).toEqual([
    { id: "legacy-gap", is_test_gap: 1 },
    { id: "legacy-other", is_test_gap: 0 },
  ]);
  migrated.close();
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
  expect(completed?.flags[0]?.hunk_hash).toMatch(/^[a-f0-9]{40}$/);
  expect(readFileSync(argsFile, "utf8")).toContain("-s read-only");
  expect(readFileSync(argsFile, "utf8")).toContain("model_reasoning_effort=\"high\"");

  expect(runner.setFlagStatus(completed!.flags[0]!.id, "treated"))
    .toMatchObject({ status: "treated" });
});

test("la portée conversation couvre plusieurs commits et tout le worktree", async () => {
  const project = projects.create({ name: "portée", path: repo });
  const conversation = conversations.create({
    projectId: project.id,
    provider: "codex",
    model: "gpt-5.6-luna",
    firstMessage: "implémente plusieurs étapes",
  });
  writeFileSync(join(repo, "src/one.ts"), "export const one = 1\n");
  git("add", ".");
  git("commit", "-qm", "première étape");
  const first = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "src/two.ts"), "export const two = 2\n");
  git("add", ".");
  git("commit", "-qm", "deuxième étape");
  const second = git("rev-parse", "HEAD");
  const now = new Date().toISOString();
  db.query(`
    INSERT INTO commit_links (commit_sha, project_id, conversation_id, created_at)
    VALUES (?, ?, ?, ?), (?, ?, ?, ?)
  `).run(first, project.id, conversation.id, now, second, project.id, conversation.id, now);
  writeFileSync(join(repo, "src/two.ts"), "export const two = 22\n");
  writeFileSync(join(repo, "src/staged.ts"), "export const staged = true\n");
  git("add", "src/staged.ts");
  writeFileSync(join(repo, "src/untracked.ts"), "export const untracked = true\n");

  const runner = new ReviewRunner(
    store,
    projects,
    conversations,
    quotas,
    async () => '{"flags":[]}',
  );
  const review = runner.start({
    projectId: project.id,
    conversationId: conversation.id,
    gitRefBase: "CONVERSATION",
    gitRefHead: "WORKTREE",
    provider: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
  });

  const completed = await runner.wait(review.id);
  expect(completed).toMatchObject({
    status: "done",
    git_ref_base: git("rev-parse", `${first}^`),
    git_ref_head: git("rev-parse", "HEAD"),
  });
  expect(completed!.diff_text).toContain("src/one.ts");
  expect(completed!.diff_text).toContain("src/two.ts");
  expect(completed!.diff_text).toContain("src/staged.ts");
  expect(completed!.diff_text).toContain("src/untracked.ts");
});

test("sur un worktree dédié, la portée conversation part du point de divergence avec le dépôt principal", async () => {
  const project = projects.create({ name: "worktree", path: repo });
  const worktree = join(dir, "wt-feature");
  git("worktree", "add", "-q", "-b", "feature", worktree);
  const conversation = conversations.create({
    projectId: project.id,
    provider: "codex",
    model: "gpt-5.6-luna",
    firstMessage: "travaille sur la branche",
    worktreePath: worktree,
  });
  // Commit fait par l'agent, sans lien enregistré (tour encore en cours).
  writeFileSync(join(worktree, "src/feature.ts"), "export const feature = 1\n");
  Bun.spawnSync(["git", "add", "."], { cwd: worktree });
  Bun.spawnSync(["git", "commit", "-qm", "feature"], { cwd: worktree });
  writeFileSync(join(worktree, "src/wip.ts"), "export const wip = true\n");

  const runner = new ReviewRunner(store, projects, conversations, quotas, async () => '{"flags":[]}');
  const review = runner.start({
    projectId: project.id,
    conversationId: conversation.id,
    gitRefBase: "CONVERSATION",
    gitRefHead: "WORKTREE",
    provider: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
  });
  const completed = await runner.wait(review.id);
  expect(completed).toMatchObject({ status: "done", git_ref_base: git("rev-parse", "HEAD") });
  expect(completed!.diff_text).toContain("src/feature.ts");
  expect(completed!.diff_text).toContain("src/wip.ts");
});

// Place devant `git` un script qui commite dans le dépôt juste avant de déléguer
// un `git diff` au vrai binaire : la fenêtre entre la lecture de HEAD et la
// capture du diff worktree devient reproductible.
function installCommitDuringDiff(options: { everyDiff: boolean }): void {
  const realGit = Bun.which("git");
  if (!realGit) throw new Error("git introuvable dans le PATH de test");
  const binDir = join(dir, "race-bin");
  mkdirSync(binDir, { recursive: true });
  const marker = join(dir, "race-marker");
  const guard = options.everyDiff ? "" : ` && [ ! -e "${marker}" ]`;
  writeFileSync(join(binDir, "git"), [
    "#!/bin/sh",
    // La sous-commande n'est pas forcément en position 1 : le sidecar préfixe
    // ses appels par des options `-c`.
    "sous_commande=''",
    "for argument in \"$@\"; do",
    "  case \"$argument\" in",
    "    -c|-C) continue;;",
    "    -*|*=*) continue;;",
    "    *) sous_commande=\"$argument\"; break;;",
    "  esac",
    "done",
    `if [ "$sous_commande" = "diff" ]${guard}; then`,
    `  : > "${marker}"`,
    `  "${realGit}" -C "${repo}" commit -q --allow-empty -m "commit concurrent" >/dev/null 2>&1`,
    "fi",
    `exec "${realGit}" "$@"`,
  ].join("\n"));
  chmodSync(join(binDir, "git"), 0o755);
  process.env.PATH = `${binDir}:${process.env.PATH}`;
}

test("rejoue la capture Gardien quand HEAD bouge pendant le diff worktree", async () => {
  const project = projects.create({ name: "course capture", path: repo });
  const conversation = conversations.create({
    projectId: project.id,
    provider: "codex",
    model: "gpt-5.6-luna",
    firstMessage: "modifie la configuration",
  });
  writeFileSync(join(repo, "src/config.ts"), "console.log('modifié pendant la review')\n");
  installCommitDuringDiff({ everyDiff: false });

  const runner = new ReviewRunner(
    store,
    projects,
    conversations,
    quotas,
    async () => '{"flags":[]}',
  );
  const review = runner.start({
    projectId: project.id,
    conversationId: conversation.id,
    gitRefBase: "CONVERSATION",
    gitRefHead: "WORKTREE",
    provider: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
  });

  const completed = await runner.wait(review.id);
  expect(completed).toMatchObject({
    status: "done",
    git_ref_head: git("rev-parse", "HEAD"),
  });
  expect(completed!.diff_text).toContain("src/config.ts");
});

test("échoue explicitement si HEAD ne se stabilise pas pendant la capture", async () => {
  const project = projects.create({ name: "course permanente", path: repo });
  const conversation = conversations.create({
    projectId: project.id,
    provider: "codex",
    model: "gpt-5.6-luna",
    firstMessage: "modifie la configuration",
  });
  writeFileSync(join(repo, "src/config.ts"), "console.log('modifié pendant la review')\n");
  installCommitDuringDiff({ everyDiff: true });

  const runner = new ReviewRunner(
    store,
    projects,
    conversations,
    quotas,
    async () => '{"flags":[]}',
  );
  const review = runner.start({
    projectId: project.id,
    conversationId: conversation.id,
    gitRefBase: "CONVERSATION",
    gitRefHead: "WORKTREE",
    provider: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
  });

  expect(await runner.wait(review.id)).toMatchObject({
    status: "error",
    error: expect.stringContaining("HEAD a changé"),
  });
});

// Variante du harnais précédent : le fichier est indexé juste après le diff des
// fichiers suivis, c'est-à-dire dans la fenêtre où `ls-files --others` cesse de
// le voir.
function installStageAfterDiff(path: string): void {
  const realGit = Bun.which("git");
  if (!realGit) throw new Error("git introuvable dans le PATH de test");
  const binDir = join(dir, "stage-bin");
  mkdirSync(binDir, { recursive: true });
  const marker = join(dir, "stage-marker");
  writeFileSync(join(binDir, "git"), [
    "#!/bin/sh",
    "sous_commande=''",
    "for argument in \"$@\"; do",
    "  case \"$argument\" in",
    "    -c|-C) continue;;",
    "    -*|*=*) continue;;",
    "    *) sous_commande=\"$argument\"; break;;",
    "  esac",
    "done",
    `if [ "$sous_commande" = "diff" ] && [ ! -e "${marker}" ]; then`,
    `  : > "${marker}"`,
    `  "${realGit}" "$@"`,
    "  code=$?",
    `  "${realGit}" -C "${repo}" add "${path}" >/dev/null 2>&1`,
    "  exit $code",
    "fi",
    `exec "${realGit}" "$@"`,
  ].join("\n"));
  chmodSync(join(binDir, "git"), 0o755);
  process.env.PATH = `${binDir}:${process.env.PATH}`;
}

test("un fichier indexé pendant la capture reste dans le diff Gardien", async () => {
  const project = projects.create({ name: "indexation concurrente", path: repo });
  const conversation = conversations.create({
    projectId: project.id,
    provider: "codex",
    model: "gpt-5.6-luna",
    firstMessage: "ajoute un module",
  });
  writeFileSync(join(repo, "src/nouveau.ts"), "export const nouveau = true\n");
  installStageAfterDiff("src/nouveau.ts");

  const runner = new ReviewRunner(
    store,
    projects,
    conversations,
    quotas,
    async () => '{"flags":[]}',
  );
  const review = runner.start({
    projectId: project.id,
    conversationId: conversation.id,
    gitRefBase: "CONVERSATION",
    gitRefHead: "WORKTREE",
    provider: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
  });

  const completed = await runner.wait(review.id);
  expect(completed).toMatchObject({ status: "done" });
  expect(completed!.diff_text).toContain("src/nouveau.ts");
});

test("un fichier non suivi disparu pendant la capture ne casse pas la review", async () => {
  const project = projects.create({ name: "fichier volatil", path: repo });
  const conversation = conversations.create({
    projectId: project.id,
    provider: "codex",
    model: "gpt-5.6-luna",
    firstMessage: "génère un artefact temporaire",
  });
  writeFileSync(join(repo, "src/config.ts"), "console.log('config modifiée')\n");
  writeFileSync(join(repo, "src/temporaire.ts"), "export const temporaire = true\n");
  const realGit = Bun.which("git");
  if (!realGit) throw new Error("git introuvable dans le PATH de test");
  const binDir = join(dir, "volatile-bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "git"), [
    "#!/bin/sh",
    "sous_commande=''",
    "for argument in \"$@\"; do",
    "  case \"$argument\" in",
    "    -c|-C) continue;;",
    "    -*|*=*) continue;;",
    "    *) sous_commande=\"$argument\"; break;;",
    "  esac",
    "done",
    `"${realGit}" "$@"`,
    "code=$?",
    `if [ "$sous_commande" = "ls-files" ]; then rm -f "${join(repo, "src/temporaire.ts")}"; fi`,
    "exit $code",
  ].join("\n"));
  chmodSync(join(binDir, "git"), 0o755);
  process.env.PATH = `${binDir}:${process.env.PATH}`;

  const runner = new ReviewRunner(
    store,
    projects,
    conversations,
    quotas,
    async () => '{"flags":[]}',
  );
  const review = runner.start({
    projectId: project.id,
    conversationId: conversation.id,
    gitRefBase: "CONVERSATION",
    gitRefHead: "WORKTREE",
    provider: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
  });

  const completed = await runner.wait(review.id);
  expect(completed).toMatchObject({ status: "done" });
  expect(completed!.diff_text).toContain("src/config.ts");
});

test("un fichier au nom accentué reste signalable par le Gardien", async () => {
  // `core.quotePath` est actif par défaut : sans neutralisation, Git rend le
  // chemin échappé en octal et plus aucun flag ne s'y ancre.
  git("config", "core.quotePath", "true");
  writeFileSync(join(repo, "src/données.ts"), "console.log(process.env.SECRET)\n");
  git("add", ".");
  git("commit", "-qm", "ajoute un fichier accentué");
  const project = projects.create({ name: "accents", path: repo });
  const conversation = conversations.create({
    projectId: project.id,
    provider: "codex",
    model: "gpt-5.6-luna",
    firstMessage: "ajoute la configuration",
  });

  const runner = new ReviewRunner(
    store,
    projects,
    conversations,
    quotas,
    async () => JSON.stringify({ flags: [{
      file: "src/données.ts",
      line_start: 1,
      line_end: 1,
      severity: "red",
      category: "secret/credential",
      message: "Ne journalise pas process.env.SECRET.",
    }] }),
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

  const completed = await runner.wait(review.id);
  expect(completed).toMatchObject({ status: "done" });
  expect(completed!.flags.map((flag) => flag.file)).toEqual(["src/données.ts"]);
});

test("interrompt le diff Gardien dès que la borne de lecture est dépassée", async () => {
  const project = projects.create({ name: "diff borné", path: repo });
  const conversation = conversations.create({
    projectId: project.id,
    provider: "codex",
    model: "gpt-5.6-luna",
    firstMessage: "génère un gros fichier",
  });
  process.env.PUPITRE_REVIEW_DIFF_MAX_BYTES = "1024";
  writeFileSync(join(repo, "src/large.ts"), `${"x".repeat(4_000)}\n`);

  const runner = new ReviewRunner(
    store,
    projects,
    conversations,
    quotas,
    async () => '{"flags":[]}',
  );
  const review = runner.start({
    projectId: project.id,
    conversationId: conversation.id,
    gitRefBase: "CONVERSATION",
    gitRefHead: "WORKTREE",
    provider: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
  });

  expect(await runner.wait(review.id)).toMatchObject({
    status: "error",
    error: expect.stringContaining("diff trop volumineux"),
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

test("ne lance pas de regroupement supplémentaire quand le scan renvoie plus de quatre flags", async () => {
  writeFileSync(join(repo, "src/config.ts"), "console.log(process.env.SECRET)\n");
  git("add", ".");
  git("commit", "-qm", "head décisions");
  const project = projects.create({ name: "regroupement modèle", path: repo });
  const conversation = conversations.create({
    projectId: project.id, provider: "codex", model: "gpt-5.6-luna", firstMessage: "modifie",
  });
  const prompts: string[] = [];
  const runner = new ReviewRunner(
    store,
    projects,
    conversations,
    quotas,
    async ({ prompt }) => {
      prompts.push(prompt);
      return JSON.stringify({ flags: Array.from({ length: 5 }, (_, index) => ({
        file: "src/config.ts",
        line_start: 1,
        line_end: 1,
        severity: index < 2 ? "red" : "orange",
        category: index < 3 ? "secret" : "contrat",
        message: `Risque ${index + 1}`,
      })) });
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

  const completed = await runner.wait(review.id);
  expect(prompts).toHaveLength(1);
  expect(completed?.flags).toHaveLength(5);
});

test("scan incrémental : un hunk intact conserve son flag sans nouveau scan", async () => {
  writeFileSync(join(repo, "src/config.ts"), "console.log(process.env.SECRET)\n");
  git("add", ".");
  git("commit", "-qm", "head incrémental");
  const project = projects.create({ name: "incrémental", path: repo });
  const conversation = conversations.create({
    projectId: project.id, provider: "codex", model: "gpt-5.6-luna", firstMessage: "x",
  });
  let calls = 0;
  const runner = new ReviewRunner(store, projects, conversations, quotas, async () => {
    calls += 1;
    return JSON.stringify({ flags: [{
      file: "src/config.ts", line_start: 1, line_end: 1, severity: "red",
      category: "secret", message: "Le secret est journalisé.",
    }] });
  });
  const input = {
    projectId: project.id, conversationId: conversation.id, gitRefBase: "HEAD^", gitRefHead: "HEAD",
    provider: "codex" as const, model: "gpt-5.6-sol", effort: "high",
  };
  const first = runner.start(input);
  await runner.wait(first.id);
  const second = runner.start({ ...input, incremental: true });
  const completed = await runner.wait(second.id);
  expect(calls).toBe(1);
  expect(completed).toMatchObject({ status: "done", parent_review_id: first.id });
  expect(completed?.flags[0]).toMatchObject({ status: "open", message: "Le secret est journalisé." });
});

test("une nouvelle review remplace la précédente : ses signalements encore ouverts passent résolus", async () => {
  writeFileSync(join(repo, "src/config.ts"), "console.log(process.env.SECRET)\n");
  git("add", ".");
  git("commit", "-qm", "head remplacé");
  const project = projects.create({ name: "remplacement", path: repo });
  const conversation = conversations.create({
    projectId: project.id, provider: "codex", model: "gpt-5.6-luna", firstMessage: "x",
  });
  const runner = new ReviewRunner(store, projects, conversations, quotas, async () => JSON.stringify({ flags: [{
    file: "src/config.ts", line_start: 1, line_end: 1, severity: "red",
    category: "secret", message: "Le secret est journalisé.",
  }] }));
  const input = {
    projectId: project.id, conversationId: conversation.id, gitRefBase: "HEAD^", gitRefHead: "HEAD",
    provider: "codex" as const, model: "gpt-5.6-sol", effort: "high",
  };
  const first = runner.start(input);
  await runner.wait(first.id);
  const second = runner.start(input);
  await runner.wait(second.id);
  expect(store.get(first.id)!.flags.map((flag) => flag.status)).toEqual(["resolved"]);
  expect(store.get(second.id)!.flags.map((flag) => flag.status)).toEqual(["open"]);
  expect(store.reviewStatus(project.id).openBySeverity.red).toBe(1);
});

test("un scan incrémental ne referme pas un signalement dont il n'a pas relu le hunk", () => {
  const project = projects.create({ name: "incrémental-prudent", path: repo });
  const conversation = conversations.create({
    projectId: project.id, provider: "codex", model: "gpt-5.6-luna", firstMessage: "x",
  });
  const input = {
    projectId: project.id, conversationId: conversation.id, gitRefBase: "base", gitRefHead: "head",
    provider: "codex" as const, model: "gpt-5.6-sol", effort: "high",
  };
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1 +1 @@", "-a", "+b", "",
  ].join("\n");
  const flag = {
    file: "src/a.ts", line_start: 1, line_end: 1, severity: "red" as const,
    category: "secret", message: "Le secret est journalisé.",
  };
  const first = store.create(input);
  store.setDiff(first.id, "base", "head", diff);
  store.complete(first.id, [{ ...flag, hunk_hash: hunkHashFor(diff, "src/a.ts", 1) }]);

  // Le hunk est toujours dans le diff et le scan incrémental ne l'a pas relu :
  // son silence ne prouve rien.
  const second = store.create({ ...input, parentReviewId: first.id });
  store.setDiff(second.id, "base", "head", diff);
  store.complete(second.id, []);
  expect(store.get(first.id)!.flags.map((item) => item.status)).toEqual(["open"]);

  // Un scan complet, lui, a tout relu : le silence vaut disparition.
  const third = store.create(input);
  store.setDiff(third.id, "base", "head", diff);
  store.complete(third.id, []);
  expect(store.get(first.id)!.flags.map((item) => item.status)).toEqual(["resolved"]);
});

test("un scan incrémental referme les signalements dont le hunk a disparu du diff", () => {
  const project = projects.create({ name: "incrémental-disparu", path: repo });
  const conversation = conversations.create({
    projectId: project.id, provider: "codex", model: "gpt-5.6-luna", firstMessage: "x",
  });
  const input = {
    projectId: project.id, conversationId: conversation.id, gitRefBase: "base", gitRefHead: "head",
    provider: "codex" as const, model: "gpt-5.6-sol", effort: "high",
  };
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1 +1 @@", "-a", "+b", "",
  ].join("\n");
  const corrected = diff.replace("+b", "+corrigé");
  const first = store.create(input);
  store.setDiff(first.id, "base", "head", diff);
  store.complete(first.id, [{
    file: "src/a.ts", line_start: 1, line_end: 1, severity: "red",
    category: "secret", message: "Le secret est journalisé.",
    hunk_hash: hunkHashFor(diff, "src/a.ts", 1),
  }]);
  const second = store.create({ ...input, parentReviewId: first.id });
  store.setDiff(second.id, "base", "head", corrected);
  store.complete(second.id, []);
  expect(store.get(first.id)!.flags.map((item) => item.status)).toEqual(["resolved"]);
});

test("deux scans worktree qui terminent à l'envers : c'est l'ordre de lancement qui tranche", () => {
  const project = projects.create({ name: "désordre", path: repo });
  const conversation = conversations.create({
    projectId: project.id, provider: "codex", model: "gpt-5.6-luna", firstMessage: "x",
  });
  const input = {
    projectId: project.id, conversationId: conversation.id, gitRefBase: "base", gitRefHead: "head",
    provider: "codex" as const, model: "gpt-5.6-sol", effort: "high",
  };
  const older = store.create(input);
  const newer = store.create(input);
  const flag = {
    file: "src/config.ts", line_start: 1, line_end: 1, severity: "red" as const,
    category: "secret", message: "Le secret est journalisé.",
  };
  store.complete(newer.id, [flag]);
  store.complete(older.id, [flag]);
  expect(store.get(older.id)!.flags.map((f) => f.status)).toEqual(["resolved"]);
  expect(store.get(newer.id)!.flags.map((f) => f.status)).toEqual(["open"]);
  expect(store.reviewStatus(project.id).openBySeverity.red).toBe(1);
});

test("scan incrémental : un hunk modifié après dispatch devient resolved sans re-signalement", async () => {
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "src/config.ts"), "console.log(process.env.SECRET)\n");
  git("add", ".");
  git("commit", "-qm", "risque initial");
  const project = projects.create({ name: "résolution incrémentale", path: repo });
  const conversation = conversations.create({
    projectId: project.id, provider: "codex", model: "gpt-5.6-luna", firstMessage: "x",
  });
  let calls = 0;
  const runner = new ReviewRunner(store, projects, conversations, quotas, async () => {
    calls += 1;
    return JSON.stringify({ flags: calls === 1 ? [{
      file: "src/config.ts", line_start: 1, line_end: 1, severity: "red",
      category: "secret", message: "Le secret est journalisé.",
    }] : [] });
  });
  const input = {
    projectId: project.id, conversationId: conversation.id, gitRefBase: base, gitRefHead: "HEAD",
    provider: "codex" as const, model: "gpt-5.6-sol", effort: "high",
  };
  const first = runner.start(input);
  const initial = await runner.wait(first.id);
  store.updateFlag(initial!.flags[0]!.id, { status: "agent_running", subtaskId: "subtask-1" });
  writeFileSync(join(repo, "src/config.ts"), "console.log('secret corrigé')\n");
  git("add", ".");
  git("commit", "-qm", "corrige le risque");
  const second = runner.start({ ...input, incremental: true });
  const completed = await runner.wait(second.id);
  expect(calls).toBe(2);
  expect(completed?.flags).toHaveLength(1);
  expect(completed?.flags[0]).toMatchObject({ status: "resolved", subtask_id: "subtask-1" });
});

test("scan incrémental : un hunk modifié sans dispatch est rescanné", async () => {
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "src/config.ts"), "console.log(process.env.SECRET)\n");
  git("add", ".");
  git("commit", "-qm", "risque initial");
  const project = projects.create({ name: "rescan sans dispatch", path: repo });
  const conversation = conversations.create({
    projectId: project.id, provider: "codex", model: "gpt-5.6-luna", firstMessage: "x",
  });
  let calls = 0;
  const runner = new ReviewRunner(store, projects, conversations, quotas, async () => {
    calls += 1;
    return JSON.stringify({ flags: [{
      file: "src/config.ts", line_start: 1, line_end: 1, severity: "red",
      category: "secret", message: `Risque ${calls}`,
    }] });
  });
  const input = {
    projectId: project.id, conversationId: conversation.id, gitRefBase: base, gitRefHead: "HEAD",
    provider: "codex" as const, model: "gpt-5.6-sol", effort: "high",
  };
  await runner.wait(runner.start(input).id);
  writeFileSync(join(repo, "src/config.ts"), "console.log(process.env.SECRET + ' modifié')\n");
  git("add", ".");
  git("commit", "-qm", "modifie le hunk");
  const completed = await runner.wait(runner.start({ ...input, incremental: true }).id);
  expect(calls).toBe(2);
  expect(completed?.flags[0]).toMatchObject({ status: "open", message: "Risque 2" });
});

test("scan incrémental : un diff devenu vide résout un flag dispatché", async () => {
  writeFileSync(join(repo, "src/config.ts"), "console.log(process.env.SECRET)\n");
  const project = projects.create({ name: "diff vide incrémental", path: repo });
  const conversation = conversations.create({
    projectId: project.id, provider: "codex", model: "gpt-5.6-luna", firstMessage: "x",
  });
  let calls = 0;
  const runner = new ReviewRunner(store, projects, conversations, quotas, async () => {
    calls += 1;
    return JSON.stringify({ flags: [{
      file: "src/config.ts", line_start: 1, line_end: 1, severity: "red",
      category: "secret", message: "Le secret est journalisé.",
    }] });
  });
  const input = {
    projectId: project.id, conversationId: conversation.id, gitRefBase: "CONVERSATION", gitRefHead: "WORKTREE",
    provider: "codex" as const, model: "gpt-5.6-sol", effort: "high",
  };
  const first = await runner.wait(runner.start(input).id);
  store.updateFlag(first!.flags[0]!.id, { status: "agent_running", subtaskId: "subtask-1" });
  git("add", ".");
  git("commit", "-qm", "intègre la correction");
  const second = await runner.wait(runner.start({ ...input, incremental: true }).id);
  expect(calls).toBe(1);
  expect(second?.flags[0]).toMatchObject({ status: "resolved", subtask_id: "subtask-1" });
});

test("persiste tous les flags sans décisions groupées", () => {
  const project = projects.create({ name: "décisions", path: repo });
  const conversation = conversations.create({
    projectId: project.id, provider: "codex", model: "gpt-5.6-luna", firstMessage: "x",
  });
  const review = store.create({
    projectId: project.id,
    conversationId: conversation.id,
    gitRefBase: "base",
    gitRefHead: "head",
    provider: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
  });
  const flags = Array.from({ length: 7 }, (_, index) => ({
    file: `src/fichier-${index}.ts`,
    line_start: index + 1,
    line_end: index + 1,
    severity: index < 2 ? "red" as const : "orange" as const,
    category: "contrat API",
    message: `Risque concret ${index}.`,
  }));
  store.complete(review.id, flags);

  const completed = store.get(review.id)!;
  expect(completed.flags).toHaveLength(7);
});

test("dispatch une zone avec le correcteur choisi et rouvre le flag si la sous-tâche échoue", async () => {
  const project = projects.create({ name: "dispatch", path: repo });
  const conversation = conversations.create({
    projectId: project.id, provider: "codex", model: "gpt-5.6-luna", effort: "xhigh",
    speed: "fast", firstMessage: "x",
  });
  const review = store.create({
    projectId: project.id, conversationId: conversation.id, gitRefBase: "base", gitRefHead: "head",
    provider: "claude", model: "opus", effort: "high",
  });
  store.setDiff(review.id, "base", "head", [
    "diff --git a/src/config.ts b/src/config.ts", "--- a/src/config.ts", "+++ b/src/config.ts",
    "@@ -1 +1 @@", "-old", "+new",
  ].join("\n"));
  store.complete(review.id, [{
    file: "src/config.ts", line_start: 1, line_end: 1, severity: "orange",
    category: "contrat", message: "Préserve le contrat public.",
  }]);
  const inputs: SubtaskInput[] = [];
  const fakeSubtasks = {
    start(input: SubtaskInput) { inputs.push(input); return { id: "dispatch-1" } as Subtask; },
    async waitResult(): Promise<SubtaskResult> {
      return { status: "error", resultText: "", error: "échec", subtask: { id: "dispatch-1" } as Subtask };
    },
  };
  const runner = new ReviewRunner(store, projects, conversations, quotas, undefined, fakeSubtasks);
  const flag = store.get(review.id)!.flags[0]!;
  expect(runner.dispatchFlag(flag.id, "Ajoute un test.", {
    provider: "claude", model: "opus", effort: "high", speed: null,
  })).toEqual({ subtaskId: "dispatch-1" });
  expect(store.getFlag(flag.id)).toMatchObject({ status: "agent_running", subtask_id: "dispatch-1", user_message: "Ajoute un test." });
  await Bun.sleep(0);
  expect(store.getFlag(flag.id)?.status).toBe("open");
  expect(inputs[0]).toMatchObject({
    readOnly: false,
    label: "Gardien · contrat · src/config.ts:1",
    conversationId: conversation.id,
    provider: "claude",
    model: "opus",
    effort: "high",
    speed: null,
  });
  expect(inputs[0]!.prompt).toContain("Consigne de l'utilisateur : Ajoute un test.");
  await settleRescan(runner, project.id, review.id);
});

test("un dispatch terminé passe en traité jusqu'au prochain scan", async () => {
  const project = projects.create({ name: "dispatch-ok", path: repo });
  const conversation = conversations.create({
    projectId: project.id, provider: "codex", model: "gpt-5.6-luna", effort: "xhigh",
    speed: "fast", firstMessage: "x",
  });
  const review = store.create({
    projectId: project.id, conversationId: conversation.id, gitRefBase: "base", gitRefHead: "head",
    provider: "codex", model: "gpt-5.6-luna", effort: "xhigh",
  });
  store.complete(review.id, [{
    file: "src/config.ts", line_start: 1, line_end: 1, severity: "orange",
    category: "contrat", message: "Préserve le contrat public.",
  }]);
  const fakeSubtasks = {
    start() { return { id: "dispatch-ok-1" } as Subtask; },
    async waitResult(): Promise<SubtaskResult> {
      return { status: "done", resultText: "corrigé", error: null, subtask: { id: "dispatch-ok-1" } as Subtask };
    },
  };
  const runner = new ReviewRunner(store, projects, conversations, quotas, undefined, fakeSubtasks);
  const flag = store.get(review.id)!.flags[0]!;
  runner.dispatchFlag(flag.id, undefined, {
    provider: "codex", model: "gpt-5.6-luna", effort: "xhigh", speed: "fast",
  });
  expect(store.getFlag(flag.id)?.status).toBe("agent_running");
  await Bun.sleep(0);
  expect(store.getFlag(flag.id)?.status).toBe("treated");
  await settleRescan(runner, project.id, review.id);
});

test("groupe plusieurs signalements dans une seule sous-tâche", async () => {
  const project = projects.create({ name: "dispatch-grouped", path: repo });
  const conversation = conversations.create({
    projectId: project.id, provider: "codex", model: "gpt-5.6-luna", firstMessage: "x",
  });
  const review = store.create({
    projectId: project.id, conversationId: conversation.id, gitRefBase: "base", gitRefHead: "head",
    provider: "codex", model: "gpt-5.6-sol", effort: "high",
  });
  store.setDiff(review.id, "base", "head", [
    "diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1 +1 @@", "-a", "+b",
    "diff --git a/src/b.ts b/src/b.ts", "--- a/src/b.ts", "+++ b/src/b.ts", "@@ -1 +1 @@", "-c", "+d",
  ].join("\n"));
  store.complete(review.id, [
    { file: "src/a.ts", line_start: 1, line_end: 1, severity: "red", category: "données", message: "Risque A." },
    { file: "src/b.ts", line_start: 1, line_end: 1, severity: "orange", category: "contrat", message: "Risque B." },
  ]);
  const inputs: SubtaskInput[] = [];
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const fakeSubtasks = {
    start(input: SubtaskInput) { inputs.push(input); return { id: "group-1" } as Subtask; },
    async waitResult(): Promise<SubtaskResult> {
      await done;
      return { status: "done", resultText: "corrigé", error: null, subtask: { id: "group-1" } as Subtask };
    },
  };
  const runner = new ReviewRunner(store, projects, conversations, quotas, async () => '{"flags":[]}', fakeSubtasks);
  const flagIds = store.get(review.id)!.flags.map((flag) => flag.id);
  expect(await runner.dispatchGrouped(review.id, ["red", "orange"], {
    provider: "codex", model: "gpt-5.6-luna", effort: "high", speed: "standard",
  })).toEqual({ subtaskId: "group-1", dispatched: 2, flagIds });
  expect(inputs).toHaveLength(1);
  expect(inputs[0]).toMatchObject({
    label: "Gardien · correction groupée · 2 signalements",
    conversationId: conversation.id,
    readOnly: false,
  });
  expect(inputs[0]!.prompt).toContain("Risque A.");
  expect(inputs[0]!.prompt).toContain("Risque B.");
  expect(store.get(review.id)!.flags.every((flag) => flag.status === "agent_running" && flag.subtask_id === "group-1")).toBe(true);

  finish();
  await Bun.sleep(0);
  expect(store.get(review.id)!.flags.every((flag) => flag.status === "treated")).toBe(true);
  await settleRescan(runner, project.id, review.id);
});

test("une correction groupée n'annonce rien tant que la sous-tâche n'a pas démarré", async () => {
  const project = projects.create({ name: "dispatch-grouped-attente", path: repo });
  const conversation = conversations.create({
    projectId: project.id, provider: "codex", model: "gpt-5.6-luna", firstMessage: "x",
  });
  const review = store.create({
    projectId: project.id, conversationId: conversation.id, gitRefBase: "base", gitRefHead: "head",
    provider: "codex", model: "gpt-5.6-sol", effort: "high",
  });
  store.complete(review.id, [
    { file: "src/a.ts", line_start: 1, line_end: 1, severity: "red", category: "données", message: "Risque A." },
  ]);
  let attempts = 0;
  const fakeSubtasks = {
    start() {
      attempts += 1;
      if (attempts < 3) throw new SubtaskLimitError("trop de sous-tâches");
      return { id: "group-attente" } as Subtask;
    },
    async waitResult(): Promise<SubtaskResult> {
      return { status: "done", resultText: "corrigé", error: null, subtask: { id: "group-attente" } as Subtask };
    },
  };
  const runner = new ReviewRunner(store, projects, conversations, quotas, async () => '{"flags":[]}', fakeSubtasks);
  const result = await runner.dispatchGrouped(review.id, ["red"], {
    provider: "codex", model: "gpt-5.6-luna", effort: "high", speed: "standard",
  });
  expect(attempts).toBe(3);
  expect(result.subtaskId).toBe("group-attente");
  expect(store.get(review.id)!.flags[0]).toMatchObject({ subtask_id: "group-attente" });
  await Bun.sleep(10);
  await settleRescan(runner, project.id, review.id);
});

test("une correction groupée qui échoue au démarrage laisse les signalements ouverts", async () => {
  const project = projects.create({ name: "dispatch-grouped-échec", path: repo });
  const conversation = conversations.create({
    projectId: project.id, provider: "codex", model: "gpt-5.6-luna", firstMessage: "x",
  });
  const review = store.create({
    projectId: project.id, conversationId: conversation.id, gitRefBase: "base", gitRefHead: "head",
    provider: "codex", model: "gpt-5.6-sol", effort: "high",
  });
  store.complete(review.id, [
    { file: "src/a.ts", line_start: 1, line_end: 1, severity: "red", category: "données", message: "Risque A." },
  ]);
  const fakeSubtasks = {
    start(): Subtask { throw new Error("agent indisponible"); },
    async waitResult(): Promise<SubtaskResult> { throw new Error("jamais"); },
  };
  const runner = new ReviewRunner(store, projects, conversations, quotas, async () => '{"flags":[]}', fakeSubtasks);
  await expect(runner.dispatchGrouped(review.id, ["red"], {
    provider: "codex", model: "gpt-5.6-luna", effort: "high", speed: "standard",
  })).rejects.toThrow("agent indisponible");
  expect(store.get(review.id)!.flags[0]!.status).toBe("open");
  expect(runner.listByProject(project.id).length).toBe(1);
});

test("la fin de la dernière correction relance une review incrémentale", async () => {
  const project = projects.create({ name: "rescan-all", path: repo });
  const conversation = conversations.create({
    projectId: project.id, provider: "codex", model: "gpt-5.6-luna", firstMessage: "x",
  });
  const review = store.create({
    projectId: project.id, conversationId: conversation.id, gitRefBase: "base", gitRefHead: "head",
    provider: "codex", model: "gpt-5.6-sol", effort: "high",
  });
  store.complete(review.id, [
    { file: "src/a.ts", line_start: 1, line_end: 1, severity: "red", category: "données", message: "Risque A." },
    { file: "src/b.ts", line_start: 1, line_end: 1, severity: "orange", category: "contrat", message: "Risque B." },
  ]);
  const fakeSubtasks = {
    start() { return { id: crypto.randomUUID() } as Subtask; },
    async waitResult(id: string): Promise<SubtaskResult> {
      return { status: "done", resultText: "corrigé", error: null, subtask: { id } as Subtask };
    },
  };
  const runner = new ReviewRunner(store, projects, conversations, quotas, async () => '{"flags":[]}', fakeSubtasks);
  const config: CorrectionAgentConfig = {
    provider: "codex", model: "gpt-5.6-luna", effort: "xhigh", speed: "fast",
  };
  runner.dispatchAll(review.id, ["red", "orange"], config);
  await Bun.sleep(50); // laisser les deux dispatches finir
  const reviews = runner.listByProject(project.id);
  expect(reviews.length).toBe(2);
  const rescan = reviews.find((item) => item.id !== review.id)!;
  expect(rescan.parent_review_id).toBe(review.id);
  expect(rescan.scope).toBe("worktree");
  expect(rescan.review_model).toBe(review.review_model);
  await runner.wait(rescan.id);
});

test("une correction isolée ne relance qu'une fois tous les dispatches finis", async () => {
  const project = projects.create({ name: "rescan-pending", path: repo });
  const conversation = conversations.create({
    projectId: project.id, provider: "codex", model: "gpt-5.6-luna", firstMessage: "x",
  });
  const review = store.create({
    projectId: project.id, conversationId: conversation.id, gitRefBase: "base", gitRefHead: "head",
    provider: "codex", model: "gpt-5.6-sol", effort: "high",
  });
  store.complete(review.id, [
    { file: "src/a.ts", line_start: 1, line_end: 1, severity: "red", category: "données", message: "Risque A." },
    { file: "src/b.ts", line_start: 1, line_end: 1, severity: "orange", category: "contrat", message: "Risque B." },
  ]);
  const flags = store.get(review.id)!.flags;
  const flagA = flags.find((flag) => flag.file === "src/a.ts")!;
  const flagB = flags.find((flag) => flag.file === "src/b.ts")!;

  let resolveB!: () => void;
  const bDone = new Promise<void>((resolve) => { resolveB = resolve; });
  const fakeSubtasks = {
    start(input: SubtaskInput) {
      return { id: input.label?.includes("src/a.ts") ? "sub-a" : "sub-b" } as Subtask;
    },
    async waitResult(id: string): Promise<SubtaskResult> {
      if (id === "sub-b") await bDone;
      return { status: "done", resultText: "corrigé", error: null, subtask: { id } as Subtask };
    },
  };
  const runner = new ReviewRunner(store, projects, conversations, quotas, async () => '{"flags":[]}', fakeSubtasks);
  const config: CorrectionAgentConfig = {
    provider: "codex", model: "gpt-5.6-luna", effort: "xhigh", speed: "fast",
  };
  runner.dispatchFlag(flagA.id, undefined, config);
  runner.dispatchFlag(flagB.id, undefined, config);
  await Bun.sleep(20);
  expect(runner.listByProject(project.id).length).toBe(1);

  resolveB();
  await Bun.sleep(50);
  const reviews = runner.listByProject(project.id);
  expect(reviews.length).toBe(2);
  const rescan = reviews.find((item) => item.id !== review.id)!;
  await runner.wait(rescan.id);
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
