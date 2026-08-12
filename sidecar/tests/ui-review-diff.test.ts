import { expect, test } from "bun:test";
import { flagActionDraft, optimisticFlagStatus, parseUnifiedDiff } from "../../ui/src/reviewDiff";
import type { ReviewFlag } from "../../ui/src/types";

function flag(overrides: Partial<ReviewFlag> = {}): ReviewFlag {
  return {
    id: "flag-1",
    review_id: "review-1",
    file: "src/value.ts",
    line_start: 2,
    line_end: 2,
    severity: "orange",
    category: "contrat API",
    message: "Vérifie le consommateur.",
    status: "open",
    code_provider: "codex",
    counter_state: "idle",
    counter_verdict: null,
    counter_text: null,
    counter_provider: null,
    counter_model: null,
    counter_effort: null,
    counter_subtask_id: null,
    counter_error: null,
    ...overrides,
  };
}

test("parse les numéros de lignes et chauffe uniquement la ligne flaggée", () => {
  const lines = parseUnifiedDiff([
    "diff --git a/src/value.ts b/src/value.ts",
    "--- a/src/value.ts",
    "+++ b/src/value.ts",
    "@@ -1,2 +1,2 @@",
    " export const stable = true",
    "-export const value = 1",
    "+export const value = 2",
  ].join("\n"), [flag()]);

  expect(lines.find((line) => line.kind === "deletion")).toMatchObject({
    oldLine: 2,
    newLine: null,
    severity: "orange",
  });
  expect(lines.find((line) => line.kind === "addition")).toMatchObject({
    oldLine: null,
    newLine: 2,
    severity: "orange",
  });
  expect(lines.find((line) => line.kind === "context")?.severity).toBeNull();
});

test("le rouge prime si plusieurs flags couvrent la même ligne", () => {
  const lines = parseUnifiedDiff([
    "diff --git a/src/value.ts b/src/value.ts",
    "--- a/src/value.ts",
    "+++ b/src/value.ts",
    "@@ -2 +2 @@",
    "-avant",
    "+après",
  ].join("\n"), [flag(), flag({ id: "flag-2", severity: "red" })]);

  expect(lines.at(-1)?.severity).toBe("red");
  expect(lines.at(-1)?.flags).toHaveLength(2);
});

test("la zone sélectionnée garde le message comme consigne modifiable et applique les statuts optimistes", () => {
  const current = flag({ message: "Ajouter un test de régression." });
  expect(flagActionDraft(current)).toBe("Ajouter un test de régression.");
  expect(optimisticFlagStatus(current, "treated").status).toBe("treated");
  expect(optimisticFlagStatus(current, "ignored").status).toBe("ignored");
});

test("un flag multi-lignes n'est porteur de carte que sur sa dernière ligne", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,3 +1,3 @@",
    " contexte",
    "+ligne un",
    "+ligne deux",
  ].join("\n");
  const lines = parseUnifiedDiff(diff, [flag({ file: "src/a.ts", line_start: 2, line_end: 3 })]);
  const carriers = lines.filter((line) => line.cardFlags.length > 0);
  expect(carriers).toHaveLength(1);
  expect(carriers[0]?.text).toBe("+ligne deux");
  // le surlignage, lui, reste sur toutes les lignes du range :
  expect(lines.filter((line) => line.flags.length > 0)).toHaveLength(2);
});

test("le message d'un signalement n'est porté que par une ligne, pas répété sur le range", () => {
  // Le marqueur affiche le message entier une fois déplié : le laisser sur
  // toutes les lignes du range répétait le texte autant de fois.
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,5 +1,5 @@",
    "+une", "+deux", "+trois", "+quatre",
  ].join("\n");
  const lines = parseUnifiedDiff(diff, [flag({ file: "src/a.ts", line_start: 1, line_end: 4 })]);

  // Un seul porteur de marqueur et de carte…
  expect(lines.filter((line) => line.cardFlags.length > 0)).toHaveLength(1);
  // …mais les quatre lignes restent surlignées.
  expect(lines.filter((line) => line.severity !== null)).toHaveLength(4);
});
