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

test("conserve les jalons de temps du tour dans son pied", () => {
  const events: AppEvent[] = [
    { type: "user-message", text: "bonjour", images: [] },
    {
      type: "turn-timing",
      phase: "started",
      startedAt: "2026-08-05T12:00:00.000Z",
    },
    { type: "status", state: "running" },
    {
      type: "turn-timing",
      phase: "first-response",
      startedAt: "2026-08-05T12:00:00.000Z",
      firstResponseAt: "2026-08-05T12:00:01.250Z",
    },
    {
      type: "turn-timing",
      phase: "completed",
      startedAt: "2026-08-05T12:00:00.000Z",
      firstResponseAt: "2026-08-05T12:00:01.250Z",
      completedAt: "2026-08-05T12:00:03.500Z",
    },
    { type: "status", state: "done" },
  ];

  expect(groupEvents(events).find((block) => block.kind === "turn-footer"))
    .toMatchObject({
      timing: {
        startedAt: "2026-08-05T12:00:00.000Z",
        firstResponseAt: "2026-08-05T12:00:01.250Z",
        completedAt: "2026-08-05T12:00:03.500Z",
      },
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

test("une précision orientée reste dans le tour courant et sépare les réponses", () => {
  const blocks = groupEvents([
    { id: 1, type: "user-message", text: "commence", images: [] },
    { id: 2, type: "status", state: "running" },
    { id: 3, type: "text-delta", text: "Première direction" },
    { id: 4, type: "user-message", text: "avec cette capture", images: ["capture.png"], steering: true },
    { id: 5, type: "text-delta", text: "Direction corrigée" },
    { id: 6, type: "status", state: "done" },
  ]);

  expect(blocks.filter((block) => block.kind === "user")).toEqual([
    expect.objectContaining({ text: "commence" }),
    expect.objectContaining({ text: "avec cette capture", steering: true }),
  ]);
  expect(blocks.filter((block) => block.kind === "assistant")).toHaveLength(2);
  expect(blocks.filter((block) => block.kind === "turn-footer")).toHaveLength(1);
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

test("un session-summary-ref devient une carte de résumé compacte", () => {
  const [block] = groupEvents([{
    id: 43,
    type: "session-summary-ref",
    summaryId: "summary-1",
    eventIdFrom: 41,
    eventIdTo: 42,
    contentMd: "## Implémenté\n- Résumé court.",
    createdAt: "2026-08-08T10:00:00.000Z",
  }]);

  expect(block).toEqual({
    kind: "session-summary",
    id: "session-summary-43-summary-1",
    summaryId: "summary-1",
    eventIdFrom: 41,
    eventIdTo: 42,
    contentMd: "## Implémenté\n- Résumé court.",
    createdAt: "2026-08-08T10:00:00.000Z",
  });
});

test("un html-document-ref devient un artefact autonome dans le fil", () => {
  const [block] = groupEvents([{
    id: 44,
    type: "html-document-ref",
    documentId: "document-1",
    title: "Audit plateforme",
    summary: "Décisions et priorités",
    sizeBytes: 12_480,
    createdAt: "2026-08-10T10:00:00.000Z",
    expiresAt: "2026-08-11T10:00:00.000Z",
  }]);

  expect(block).toEqual({
    kind: "html-document",
    id: "html-document-44-document-1",
    documentId: "document-1",
    title: "Audit plateforme",
    summary: "Décisions et priorités",
    sizeBytes: 12_480,
    createdAt: "2026-08-10T10:00:00.000Z",
    expiresAt: "2026-08-11T10:00:00.000Z",
  });
});

test("un document-ref PDF permanent conserve son format dans le fil", () => {
  const [block] = groupEvents([{
    id: 45,
    type: "document-ref",
    documentId: "document-pdf",
    title: "Rapport",
    kind: "pdf",
    mimeType: "application/pdf",
    originalName: "rapport.pdf",
    sizeBytes: 42_000,
    createdAt: "2026-08-10T10:00:00.000Z",
    expiresAt: null,
  }]);

  expect(block).toMatchObject({
    kind: "html-document",
    documentId: "document-pdf",
    documentKind: "pdf",
    mimeType: "application/pdf",
    originalName: "rapport.pdf",
    expiresAt: null,
  });
});

test("le pied de tour compte les sous-tâches réellement lancées", () => {
  // Un modèle peut affirmer avoir délégué sans l'avoir fait : le compte vient
  // des événements, jamais de sa parole.
  const blocks = groupEvents([
    { type: "user-message", text: "délègue deux analyses", images: [] },
    { type: "subtask-ref", subtaskId: "s1", provider: "claude", model: "sonnet" },
    { type: "subtask-ref", subtaskId: "s2", provider: "claude", model: "sonnet" },
    { type: "text-final", text: "c'est fait" },
    { type: "status", state: "done" },
  ] as never);

  const footer = blocks.find((block) => block.kind === "turn-footer") as { subtaskCount?: number };
  expect(footer?.subtaskCount).toBe(2);
});

test("un tour sans sous-tâche n'affiche aucun compte", () => {
  const blocks = groupEvents([
    { type: "user-message", text: "réponds", images: [] },
    { type: "text-final", text: "j'ai délégué (mensonge)" },
    { type: "status", state: "done" },
  ] as never);

  const footer = blocks.find((block) => block.kind === "turn-footer") as { subtaskCount?: number };
  expect(footer?.subtaskCount).toBeUndefined();
});
