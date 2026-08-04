import { expect, test } from "bun:test";
import { parseUnifiedDiff } from "../../ui/src/reviewDiff";
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
