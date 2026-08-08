import { expect, test } from "bun:test";
import { reviewStartInput } from "../../ui/src/reviewLaunch";

test("un scan du worktree ne fournit pas de refs explicites", () => {
  expect(reviewStartInput("conversation", null)).toEqual({ conversationId: "conversation", scope: "worktree" });
});

test("un scan de comparaison réutilise les refs affichées", () => {
  expect(reviewStartInput("conversation", { base: "main", head: "feature" })).toEqual({
    conversationId: "conversation", scope: "comparison", gitRefBase: "main", gitRefHead: "feature",
  });
});
