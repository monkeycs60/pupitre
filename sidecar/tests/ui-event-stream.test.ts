import { expect, test } from "bun:test";
import { groupEvents } from "../../ui/src/groupEvents";
import type { AppEvent } from "../../ui/src/types";

test("cumule les mises à jour d'usage incrémentales d'un même tour", () => {
  const events: AppEvent[] = [
    { type: "user-message", text: "bonjour", images: [] },
    { type: "status", state: "running" },
    { type: "usage", inputTokens: 10, outputTokens: 2 },
    { type: "usage", inputTokens: 20, outputTokens: 3 },
    { type: "status", state: "done" },
  ];

  const footer = groupEvents(events).find((block) => block.kind === "turn-footer");
  expect(footer).toMatchObject({
    kind: "turn-footer",
    usage: { inputTokens: 30, outputTokens: 5 },
  });
});
