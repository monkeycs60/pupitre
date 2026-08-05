import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { QuotaTracker } from "../src/quotas";
import {
  parseReviewDecisionOutput,
  parseReviewOutput,
  ReviewRunner,
  splitDiffIntoZones,
} from "../src/reviews";
import { ConversationStore } from "../src/stores/conversations";
import { PresetStore } from "../src/stores/presets";
import { ProjectStore } from "../src/stores/projects";
import { ReviewStore } from "../src/stores/reviews";
import type { Subtask, SubtaskInput, SubtaskResult } from "../src/subtasks";
import { SubtaskLimitError } from "../src/subtasks";

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
  for (const key of [
    "PUPITRE_CODEX_BIN",
    "PUPITRE_CODEX_MODE",
    "PUPITRE_REVIEW_DIFF_MAX_BYTES",
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
    decision: "OK pour accepter ce point : Ne journalisez pas process.env.SECRET, car sa valeur sera exposée dans les logs ; supprimez ce log ou remplacez-le par un indicateur non sensible.",
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

test("valide un regroupement sémantique de 2 à 4 décisions sans perdre de flag", () => {
  expect(parseReviewDecisionOutput(JSON.stringify({ decisions: [
    { question: "OK pour changer le contrat API ?", flag_numbers: [1, 3, 5] },
    { question: "OK pour migrer les données ?", flag_numbers: [2, 4] },
  ] }), 5)).toEqual([
    { question: "OK pour changer le contrat API ?", flag_indexes: [0, 2, 4] },
    { question: "OK pour migrer les données ?", flag_indexes: [1, 3] },
  ]);
  expect(() => parseReviewDecisionOutput(JSON.stringify({ decisions: [
    { question: "Décision incomplète", flag_numbers: [1, 2] },
    { question: "Autre décision", flag_numbers: [2, 3] },
  ] }), 3)).toThrow(/exactement une fois/);
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
    openFlagCount: 1,
    pendingReviewCount: 1,
  });
  expect(runner.setFlagStatus(completed!.flags[0]!.id, "acked"))
    .toMatchObject({ status: "acked" });
  expect(runner.gardienStatus(project.id)).toEqual({
    mode: "bloquant",
    blocked: false,
    openRedCount: 0,
    openFlagCount: 0,
    pendingReviewCount: 0,
  });
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
    git_ref_head: "WORKTREE",
  });
  expect(completed!.diff_text).toContain("src/one.ts");
  expect(completed!.diff_text).toContain("src/two.ts");
  expect(completed!.diff_text).toContain("src/staged.ts");
  expect(completed!.diff_text).toContain("src/untracked.ts");
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

test("demande au modèle fort de regrouper sémantiquement plus de quatre flags", async () => {
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
      if (prompt.includes("Regroupe ces risques")) {
        return JSON.stringify({ decisions: [
          { question: "OK pour exposer les valeurs sensibles ?", flag_numbers: [1, 2, 3] },
          { question: "OK pour modifier le contrat de logs ?", flag_numbers: [4, 5] },
        ] });
      }
      return JSON.stringify({ flags: Array.from({ length: 5 }, (_, index) => ({
        file: "src/config.ts",
        line_start: 1,
        line_end: 1,
        severity: index < 2 ? "red" : "orange",
        category: index < 3 ? "secret" : "contrat",
        message: `Risque ${index + 1}`,
        decision: `OK pour le risque ${index + 1} ?`,
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
  expect(prompts).toHaveLength(2);
  expect(completed?.decisions.map((decision) => decision.flag_ids.length)).toEqual([3, 2]);
});

test("le contre-avis passe au provider opposé en lecture seule et persiste son verdict", async () => {
  const project = projects.create({ name: "contre-avis", path: repo });
  const conversation = conversations.create({
    projectId: project.id,
    provider: "codex",
    model: "gpt-5.6-luna",
    firstMessage: "écris le changement",
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
  store.setDiff(review.id, "base", "head", [
    "diff --git a/src/config.ts b/src/config.ts",
    "--- a/src/config.ts",
    "+++ b/src/config.ts",
    "@@ -1 +1 @@",
    "-export const secret = false",
    "+export const secret = true",
  ].join("\n"));
  store.complete(review.id, [{
    file: "src/config.ts",
    line_start: 1,
    line_end: 1,
    severity: "red",
    category: "secret/credential",
    message: "Vérifie que cette valeur ne divulgue pas un secret.",
  }]);

  const inputs: SubtaskInput[] = [];
  let attempts = 0;
  const fakeSubtasks = {
    start(input: SubtaskInput) {
      attempts += 1;
      if (attempts === 1) throw new SubtaskLimitError("slots occupés");
      inputs.push(input);
      return { id: "counter-subtask" } as Subtask;
    },
    async waitResult(): Promise<SubtaskResult> {
      return {
        status: "done",
        resultText: '{"verdict":"nuanced","text":"Le risque existe seulement si la valeur est sérialisée."}',
        error: null,
        subtask: { id: "counter-subtask" } as SubtaskResult["subtask"],
      };
    },
  };
  const runner = new ReviewRunner(
    store,
    projects,
    conversations,
    quotas,
    undefined,
    fakeSubtasks,
  );
  const flagId = store.get(review.id)!.flags[0]!.id;
  runner.startCounterOpinions([flagId]);
  expect(() => runner.startCounterOpinions([flagId])).toThrow(/déjà en cours/);
  expect(() => runner.setFlagCodeProvider(flagId, "claude")).toThrow(/pendant un contre-avis/);
  expect(store.getFlag(flagId)?.code_provider).toBe("codex");
  const countered = await runner.waitCounter(flagId);

  expect(inputs).toHaveLength(1);
  expect(inputs[0]).toMatchObject({
    provider: "claude",
    model: "opus",
    effort: "high",
    readOnly: true,
  });
  expect(inputs[0]!.prompt).toContain("objectif est la certitude");
  expect(countered).toMatchObject({
    status: "countered",
    counter_state: "done",
    counter_verdict: "nuanced",
    counter_provider: "claude",
    counter_model: "opus",
    counter_text: "Le risque existe seulement si la valeur est sérialisée.",
  });
  expect(runner.setFlagCodeProvider(flagId, "claude")).toMatchObject({
    code_provider: "claude",
    status: "open",
    counter_state: "idle",
    counter_text: null,
  });
  projects.setGardienMode(project.id, "bloquant");
  expect(runner.gardienStatus(project.id)).toEqual({
    mode: "bloquant",
    blocked: true,
    openRedCount: 1,
    openFlagCount: 1,
    pendingReviewCount: 1,
  });
  const decisionId = store.get(review.id)!.decisions[0]!.id;
  runner.setDecisionStatus(decisionId, "acked");
  expect(runner.gardienStatus(project.id)?.blocked).toBe(false);
  runner.startCounterOpinions([flagId]);
  expect((await runner.waitCounter(flagId))?.status).toBe("countered");
  expect(store.get(review.id)!.decisions[0]!.status).toBe("open");
  expect(runner.gardienStatus(project.id)?.blocked).toBe(true);
});

test("persiste quatre décisions sémantiques explicites sans regroupement implicite", () => {
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
    decision: `OK pour le changement ${index} ?`,
  }));
  store.complete(review.id, flags, [
    { question: "OK pour les deux changements de contrat ?", flag_indexes: [0, 4] },
    { question: "OK pour les deux migrations liées ?", flag_indexes: [1, 5] },
    { question: "OK pour les deux comportements silencieux ?", flag_indexes: [2, 6] },
    { question: "OK pour la gestion d'erreur ?", flag_indexes: [3] },
  ]);

  const completed = store.get(review.id)!;
  expect(completed.decisions).toHaveLength(4);
  expect(completed.decisions.flatMap((decision) => decision.flag_ids).sort())
    .toEqual(completed.flags.map((flag) => flag.id).sort());
});

test("contre-expertise chaque flag avec le provider opposé à son auteur réel", async () => {
  const project = projects.create({ name: "auteurs mixtes", path: repo });
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
  store.complete(review.id, [
    {
      file: "src/codex.ts", line_start: 1, line_end: 1, severity: "red",
      category: "données", message: "Risque Codex.",
    },
    {
      file: "src/claude.ts", line_start: 1, line_end: 1, severity: "orange",
      category: "contrat", message: "Risque Claude.",
    },
  ]);
  const flags = store.get(review.id)!.flags;
  store.setFlagCodeProvider(flags[1]!.id, "claude");
  const inputs: SubtaskInput[] = [];
  const fakeSubtasks = {
    start(input: SubtaskInput) {
      inputs.push(input);
      return { id: `counter-${inputs.length}` } as Subtask;
    },
    async waitResult(id: string): Promise<SubtaskResult> {
      return {
        status: "done",
        resultText: '{"verdict":"confirmed","text":"Risque confirmé."}',
        error: null,
        subtask: { id } as Subtask,
      };
    },
  };
  const runner = new ReviewRunner(
    store, projects, conversations, quotas, undefined, fakeSubtasks,
  );
  runner.startCounterOpinions(flags.map((flag) => flag.id));
  await Promise.all(flags.map((flag) => runner.waitCounter(flag.id)));

  expect(inputs.map(({ provider, model }) => ({ provider, model })))
    .toEqual(expect.arrayContaining([
      { provider: "claude", model: "opus" },
      { provider: "codex", model: "gpt-5.6-sol" },
    ]));
});

test("un re-contre-avis échoué ne conserve pas un statut countered sans verdict", async () => {
  const project = projects.create({ name: "re-contre-avis", path: repo });
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
  store.complete(review.id, [{
    file: "src/a.ts", line_start: 1, line_end: 1, severity: "red",
    category: "données", message: "Risque initial.",
  }]);
  const flagId = store.get(review.id)!.flags[0]!.id;
  store.completeCounter(flagId, "confirmed", "Ancien verdict.");
  const fakeSubtasks = {
    start() {
      return { id: "counter-error" } as Subtask;
    },
    async waitResult(): Promise<SubtaskResult> {
      return {
        status: "error",
        resultText: "",
        error: "échec simulé",
        subtask: { id: "counter-error" } as Subtask,
      };
    },
  };
  const runner = new ReviewRunner(
    store, projects, conversations, quotas, undefined, fakeSubtasks,
  );
  runner.startCounterOpinions([flagId], { codeProvider: "claude" });
  await runner.waitCounter(flagId);

  expect(store.getFlag(flagId)).toMatchObject({
    code_provider: "claude",
    status: "open",
    counter_state: "error",
    counter_verdict: null,
    counter_text: null,
  });
  expect(store.get(review.id)!.decisions[0]!.status).toBe("open");
});

test("synchronise les statuts flag-décision et préserve les acquis au backfill", () => {
  const project = projects.create({ name: "migration décisions", path: repo });
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
  store.complete(review.id, [
    {
      file: "src/a.ts", line_start: 1, line_end: 1, severity: "red",
      category: "données", message: "Préserve A.",
    },
    {
      file: "src/b.ts", line_start: 2, line_end: 2, severity: "orange",
      category: "contrat", message: "Préserve B.",
    },
  ]);
  const completed = store.get(review.id)!;
  store.setDecisionStatus(completed.decisions[0]!.id, "acked");
  store.setFlagStatus(completed.flags[0]!.id, "open");
  expect(store.getDecision(completed.decisions[0]!.id)?.status).toBe("open");
  for (const flag of completed.flags) store.setFlagStatus(flag.id, "acked");
  db.query("UPDATE review_decisions SET status = 'open' WHERE review_id = ?").run(review.id);

  const reopened = new ReviewStore(db).get(review.id)!;
  expect(reopened.decisions).toHaveLength(2);
  expect(reopened.decisions.every((decision) => decision.status === "acked")).toBe(true);
});

test("l'option projet lance automatiquement les contre-avis rouges", async () => {
  writeFileSync(join(repo, "src/config.ts"), "console.log(process.env.SECRET)\n");
  git("add", ".");
  git("commit", "-qm", "head auto");
  const project = projects.create({ name: "auto", path: repo });
  projects.setAutoCounterRed(project.id, true);
  const conversation = conversations.create({
    projectId: project.id,
    provider: "codex",
    model: "gpt-5.6-luna",
    firstMessage: "modifie la configuration",
  });
  let counterStarts = 0;
  const fakeSubtasks = {
    start() {
      counterStarts += 1;
      return { id: `counter-${counterStarts}` } as Subtask;
    },
    async waitResult(): Promise<SubtaskResult> {
      return {
        status: "done",
        resultText: '{"verdict":"confirmed","text":"Le secret serait exposé dans les logs."}',
        error: null,
        subtask: { id: "counter-1" } as Subtask,
      };
    },
  };
  const runner = new ReviewRunner(
    store,
    projects,
    conversations,
    quotas,
    async () => '{"flags":[{"file":"src/config.ts","line_start":1,"line_end":1,'
      + '"severity":"red","category":"secret/credential",'
      + '"message":"Ne journalise pas le secret."}]}',
    fakeSubtasks,
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
  const flagId = completed!.flags[0]!.id;
  await runner.waitCounter(flagId);

  expect(counterStarts).toBe(1);
  expect(store.getFlag(flagId)).toMatchObject({
    counter_state: "done",
    counter_verdict: "confirmed",
    counter_provider: "claude",
  });
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
