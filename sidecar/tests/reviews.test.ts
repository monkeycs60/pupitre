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
  projects.setGardienMode(project.id, "bloquant");
  expect(runner.gardienStatus(project.id)).toEqual({
    mode: "bloquant",
    blocked: true,
    openRedCount: 1,
  });
  const decisionId = store.get(review.id)!.decisions[0]!.id;
  runner.setDecisionStatus(decisionId, "acked");
  expect(runner.gardienStatus(project.id)?.blocked).toBe(false);
  runner.startCounterOpinions([flagId]);
  expect((await runner.waitCounter(flagId))?.status).toBe("countered");
  expect(store.get(review.id)!.decisions[0]!.status).toBe("open");
  expect(runner.gardienStatus(project.id)?.blocked).toBe(true);
});

test("regroupe les flags en quatre décisions ciblées au maximum", () => {
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
  store.complete(review.id, Array.from({ length: 7 }, (_, index) => ({
    file: `src/fichier-${index}.ts`,
    line_start: index + 1,
    line_end: index + 1,
    severity: index < 2 ? "red" as const : "orange" as const,
    category: "contrat API",
    message: `Risque concret ${index}.`,
    decision: `OK pour le changement ${index} ?`,
  })));

  const completed = store.get(review.id)!;
  expect(completed.decisions).toHaveLength(4);
  expect(completed.decisions.flatMap((decision) => decision.flag_ids).sort())
    .toEqual(completed.flags.map((flag) => flag.id).sort());
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
