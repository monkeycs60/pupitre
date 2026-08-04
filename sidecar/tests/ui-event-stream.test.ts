import { expect, test } from "bun:test";
import { groupEvents } from "../../ui/src/groupEvents";
import type { AppEvent, StoredEvent } from "../../ui/src/types";

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

test("les clés restent uniques quand un outil réutilise son id sur plusieurs tours", () => {
  const events: StoredEvent[] = [
    { id: 1, type: "user-message", text: "un", images: [] },
    { id: 2, type: "tool-start", toolId: "shell", toolName: "shell", input: {} },
    { id: 3, type: "tool-end", toolId: "shell", output: "ok", images: [] },
    { id: 4, type: "status", state: "done" },
    { id: 5, type: "user-message", text: "deux", images: [] },
    { id: 6, type: "tool-start", toolId: "shell", toolName: "shell", input: {} },
    { id: 7, type: "tool-end", toolId: "shell", output: "ok", images: [] },
    { id: 8, type: "status", state: "done" },
  ];

  const ids = groupEvents(events).map((block) => block.id);
  expect(new Set(ids).size).toBe(ids.length);
});

test("un debrief-ref devient un bloc éditorial autonome", () => {
  const [block] = groupEvents([{
    id: 42,
    type: "debrief-ref",
    debriefId: "debrief-1",
    eventIdFrom: 3,
    eventIdTo: 40,
    contentMd: "## Décisions et pourquoi\nSQLite.",
    createdAt: "2026-08-04T10:00:00.000Z",
  }]);

  expect(block).toEqual({
    kind: "debrief",
    id: "debrief-42-debrief-1",
    debriefId: "debrief-1",
    eventIdFrom: 3,
    eventIdTo: 40,
    contentMd: "## Décisions et pourquoi\nSQLite.",
    createdAt: "2026-08-04T10:00:00.000Z",
  });
});
