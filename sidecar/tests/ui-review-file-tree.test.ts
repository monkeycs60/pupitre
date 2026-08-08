import { expect, test } from "bun:test";
import { buildFileTree } from "../../ui/src/reviewFileTree";
import type { ReviewFlag } from "../../ui/src/types";

function flag(overrides: Partial<ReviewFlag>): ReviewFlag {
  return {
    id: "flag", review_id: "review", file: "src/a.ts", line_start: 1, line_end: 1,
    severity: "orange", category: "risk", message: "message", status: "open",
    code_provider: "codex", counter_state: "idle", counter_verdict: null,
    counter_text: null, counter_provider: null, counter_model: null,
    counter_effort: null, counter_subtask_id: null, counter_error: null,
    ...overrides,
  };
}

test("construit les fichiers dans l'ordre du diff et compte ajouts, suppressions et sévérités", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts",
    "@@ -1 +1,2 @@", "-old", "+new", "+next",
    "diff --git a/src/b.ts b/src/b.ts", "--- a/src/b.ts", "+++ b/src/b.ts",
    "@@ -3 +3 @@", "-before", "+after",
  ].join("\n");
  const tree = buildFileTree(diff, [
    flag({ id: "red", severity: "red" }),
    flag({ id: "grey", severity: "grey", file: "src/b.ts", status: "resolved" }),
    flag({ id: "orange", severity: "orange", file: "src/b.ts", status: "countered" }),
  ]);

  expect(tree).toEqual([
    { path: "src/a.ts", additions: 2, deletions: 1, counts: { red: 1, orange: 0, grey: 0 }, openCount: 1 },
    { path: "src/b.ts", additions: 1, deletions: 1, counts: { red: 0, orange: 1, grey: 1 }, openCount: 1 },
  ]);
});
