import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { DebriefRunner } from "../src/debriefs";
import { ConversationActivity } from "../src/conversation-activity";
import { QuotaTracker } from "../src/quotas";
import { ConversationStore } from "../src/stores/conversations";
import { DebriefStore } from "../src/stores/debriefs";
import { ProjectStore } from "../src/stores/projects";

function setup() {
  const db = openDb(mkdtempSync(join(tmpdir(), "pupitre-debriefs-")));
  const projects = new ProjectStore(db);
  const conversations = new ConversationStore(db);
  const project = projects.create({ name: "Test", path: tmpdir() });
  const conversation = conversations.create({
    projectId: project.id,
    provider: "codex",
    model: "gpt-test",
    effort: "high",
    firstMessage: "Fil de test",
  });
  return { db, projects, conversations, conversation };
}

test("un débrief est versionné et référencé atomiquement dans le fil", async () => {
  const { db, projects, conversations, conversation } = setup();
  const firstId = conversations.appendEvent(conversation.id, {
    type: "user-message",
    text: "Choisis SQLite plutôt que Postgres.",
    images: [],
  });
  const lastId = conversations.appendEvent(conversation.id, {
    type: "text-final",
    text: "SQLite est retenu pour rester local-first.",
  });
  const broadcasts: unknown[] = [];
  let capturedPrompt = "";
  const runner = new DebriefRunner(
    new DebriefStore(db),
    conversations,
    projects,
    new QuotaTracker(db),
    (_conversationId, event) => broadcasts.push(event),
    async (input) => {
      capturedPrompt = input.prompt;
      return "## Ce qui a été construit\nStockage local.\n\n## Décisions et pourquoi\nSQLite.\n\n## Alternatives écartées\nPostgres.\n\n## Implications\nLocal.\n\n## Points ouverts\nAucun.";
    },
  );

  const debrief = await runner.generate(conversation.id);

  expect(debrief.event_id_from).toBe(firstId);
  expect(debrief.event_id_to).toBe(lastId);
  expect(capturedPrompt).toContain("événement #" + firstId);
  expect(capturedPrompt).toContain("SQLite plutôt que Postgres");
  expect(capturedPrompt).toContain("## Ce qui a été construit");
  expect(new DebriefStore(db).listByConversation(conversation.id)).toEqual([debrief]);
  expect(conversations.listEvents(conversation.id).at(-1)).toEqual(
    expect.objectContaining({ type: "debrief-ref", debriefId: debrief.id }),
  );
  expect(broadcasts).toHaveLength(1);
  db.close();
});

test("un résumé de session ne conserve que les changements concrets", async () => {
  const { db, projects, conversations, conversation } = setup();
  const firstId = conversations.appendEvent(conversation.id, {
    type: "user-message",
    text: "Ajoute le résumé court.",
    images: [],
  });
  conversations.appendEvent(conversation.id, {
    type: "text-final",
    text: "Le résumé court est ajouté.",
  });
  const broadcasts: unknown[] = [];
  let capturedPrompt = "";
  let capturedModel: { provider: string; model: string; effort?: string; speed?: string } | null = null;
  const runner = new DebriefRunner(
    new DebriefStore(db),
    conversations,
    projects,
    new QuotaTracker(db),
    (_conversationId, event) => broadcasts.push(event),
    async (input) => {
      capturedPrompt = input.prompt;
      capturedModel = input;
      return "## Implémenté\n- Résumé court ajouté [événement #1].\n\n## À terminer\n- Vérifier l'export.";
    },
  );

  const summary = await runner.generateSessionSummary(conversation.id);

  expect(summary.event_id_from).toBe(firstId);
  expect(summary.content_md).toContain("## Implémenté");
  expect(capturedPrompt).toContain("résumé de session");
  expect(capturedPrompt).toContain("Ajoute le résumé court");
  expect(capturedModel).toEqual(expect.objectContaining({
    provider: "codex", model: "gpt-5.6-luna", effort: "high", speed: "fast",
  }));
  expect(conversations.listEvents(conversation.id).at(-1)).toEqual(
    expect.objectContaining({ type: "session-summary-ref", summaryId: summary.id }),
  );
  expect(broadcasts).toHaveLength(1);
  await expect(runner.generateSessionSummary(conversation.id)).rejects.toThrow(
    "aucun nouvel événement à résumer",
  );
  db.close();
});

test("un résumé au format non conforme est rejeté avant persistance", async () => {
  const { db, projects, conversations, conversation } = setup();
  conversations.appendEvent(conversation.id, {
    type: "text-final",
    text: "Changement concret.",
  });
  let generated = "## Implémenté\n- ok\n\n## Digression\n- hors format";
  const runner = new DebriefRunner(
    new DebriefStore(db),
    conversations,
    projects,
    new QuotaTracker(db),
    () => {},
    async () => generated,
  );

  await expect(runner.generateSessionSummary(conversation.id)).rejects.toThrow(
    "titre interdit",
  );

  generated = `## Implémenté\n${Array.from({ length: 9 }, (_, i) => `- puce ${i}`).join("\n")}`;
  await expect(runner.generateSessionSummary(conversation.id)).rejects.toThrow(
    "maximum 8",
  );

  // Rien ne doit avoir été persisté dans le fil.
  expect(
    conversations.listEvents(conversation.id).some((event) => event.type === "session-summary-ref"),
  ).toBe(false);
  db.close();
});

test("consolide les résumés partiels par paliers bornés", async () => {
  const { db, projects, conversations, conversation } = setup();
  for (let index = 0; index < 460; index += 1) {
    conversations.appendEvent(conversation.id, {
      type: "text-final",
      text: `Événement long ${index} ${"x".repeat(7_900)}`,
    });
  }
  const prompts: string[] = [];
  const runner = new DebriefRunner(
    new DebriefStore(db),
    conversations,
    projects,
    new QuotaTracker(db),
    () => {},
    async (input) => {
      prompts.push(input.prompt);
      return `## Implémenté\n- ${"x".repeat(5_900)}`;
    },
  );

  const summary = await runner.generateSessionSummary(conversation.id);

  expect(summary.content_md).toContain("## Implémenté");
  // Plusieurs partiels, puis une consolidation en plus d'un appel : par paliers.
  expect(prompts.length).toBeGreaterThan(20);
  const consolidations = prompts.filter((prompt) => prompt.includes("Fusionne les résumés"));
  expect(consolidations.length).toBeGreaterThan(1);
  // Aucun appel de consolidation ne doit dépasser la fenêtre bornée.
  for (const prompt of consolidations) {
    expect(prompt.length).toBeLessThan(110_000);
  }
  db.close();
});

test("la version suivante ne résume que les événements postérieurs au dernier débrief", async () => {
  const { db, projects, conversations, conversation } = setup();
  conversations.appendEvent(conversation.id, {
    type: "user-message",
    text: "Ancienne décision",
    images: [],
  });
  const prompts: string[] = [];
  const runner = new DebriefRunner(
    new DebriefStore(db),
    conversations,
    projects,
    new QuotaTracker(db),
    () => {},
    async (input) => {
      prompts.push(input.prompt);
      return `## Ce qui a été construit\n${prompts.length === 1 ? "Socle initial." : "Évolution récente."}\n\n## Décisions et pourquoi\nDécision.\n\n## Alternatives écartées\nAucune.\n\n## Implications\nRAS.\n\n## Points ouverts\nAucun.`;
    },
  );
  await runner.generate(conversation.id);
  const nextId = conversations.appendEvent(conversation.id, {
    type: "user-message",
    text: "Nouvelle décision",
    images: [],
  });

  const second = await runner.generate(conversation.id);

  expect(second.event_id_from).toBe(nextId);
  expect(prompts[1]).toContain("Nouvelle décision");
  expect(prompts[1]).not.toContain("Ancienne décision");
  expect(new DebriefStore(db).listByConversation(conversation.id)).toHaveLength(2);
  await expect(runner.generate(conversation.id)).rejects.toThrow("aucun nouvel événement");
  expect(await runner.latestOrGenerate(conversation.id)).toEqual(second);
  expect(new DebriefStore(db).listByConversation(conversation.id)).toHaveLength(2);

  let handoff = "";
  await runner.withHandoff(conversation.id, async (artifact) => {
    handoff = artifact.contentMd;
  });
  expect(handoff).toContain("Débrief 1");
  expect(handoff).toContain("Socle initial");
  expect(handoff).toContain("Débrief 2");
  expect(handoff).toContain("Évolution récente");
  db.close();
});

test("refuse un débrief sans état construit", async () => {
  const { db, projects, conversations, conversation } = setup();
  conversations.appendEvent(conversation.id, {
    type: "user-message",
    text: "Travail terminé",
    images: [],
  });
  const runner = new DebriefRunner(
    new DebriefStore(db),
    conversations,
    projects,
    new QuotaTracker(db),
    () => {},
    async () => "## Décisions et pourquoi\nRAS.\n\n## Alternatives écartées\nRAS.\n\n## Implications\nRAS.\n\n## Points ouverts\nRAS.",
  );

  await expect(runner.generate(conversation.id)).rejects.toThrow("Ce qui a été construit");
  db.close();
});

test("le verrou partagé couvre toute la génération du débrief", async () => {
  const { db, projects, conversations, conversation } = setup();
  conversations.appendEvent(conversation.id, {
    type: "user-message",
    text: "Débrief lent",
    images: [],
  });
  const activity = new ConversationActivity();
  let finish!: (content: string) => void;
  const generated = new Promise<string>((resolve) => {
    finish = resolve;
  });
  const runner = new DebriefRunner(
    new DebriefStore(db),
    conversations,
    projects,
    new QuotaTracker(db),
    () => {},
    () => generated,
    activity,
  );

  const pending = runner.generate(conversation.id);
  expect(activity.isBusy(conversation.id)).toBe(true);
  expect(() => activity.acquire(conversation.id, "turn")).toThrow(
    "une opération est déjà en cours",
  );
  finish("## Ce qui a été construit\nSocle.\n\n## Décisions et pourquoi\nRAS.\n\n## Alternatives écartées\nRAS.\n\n## Implications\nRAS.\n\n## Points ouverts\nRAS.");
  await pending;
  expect(activity.isBusy(conversation.id)).toBe(false);
  db.close();
});

test("hiérarchise un long segment au lieu de refuser le débrief", async () => {
  const { db, projects, conversations, conversation } = setup();
  for (let index = 0; index < 30; index += 1) {
    conversations.appendEvent(conversation.id, {
      type: "text-final",
      text: `Événement long ${index} ${"x".repeat(7_900)}`,
    });
  }
  const prompts: string[] = [];
  const runner = new DebriefRunner(
    new DebriefStore(db),
    conversations,
    projects,
    new QuotaTracker(db),
    () => {},
    async (input) => {
      prompts.push(input.prompt);
      return "## Ce qui a été construit\nSocle.\n\n## Décisions et pourquoi\nRAS.\n\n## Alternatives écartées\nRAS.\n\n## Implications\nRAS.\n\n## Points ouverts\nRAS.";
    },
  );

  const debrief = await runner.generate(conversation.id);

  expect(debrief.event_id_to).toBeGreaterThan(debrief.event_id_from);
  expect(prompts.length).toBeGreaterThan(2);
  expect(prompts.at(-1)).toContain("SYNTHÈSES PARTIELLES");
  db.close();
});

test("condense un historique de passation qui dépasse son budget", async () => {
  const { db, projects, conversations, conversation } = setup();
  const store = new DebriefStore(db);
  let lastEventId = 0;
  for (let index = 0; index < 20; index += 1) {
    lastEventId = conversations.appendEvent(conversation.id, {
      type: "text-final",
      text: `lot ${index}`,
    });
    store.createWithReference({
      conversationId: conversation.id,
      eventIdFrom: lastEventId,
      eventIdTo: lastEventId,
      contentMd: `## Ce qui a été construit\n${"x".repeat(7_000)}\n\n## Décisions et pourquoi\nDécision [événement #${lastEventId}].\n\n## Alternatives écartées\nRAS.\n\n## Implications\nRAS.\n\n## Points ouverts\nRAS.`,
    });
  }
  const prompts: string[] = [];
  const runner = new DebriefRunner(
    store,
    conversations,
    projects,
    new QuotaTracker(db),
    () => {},
    async (input) => {
      prompts.push(input.prompt);
      return "## Ce qui a été construit\nSynthèse cumulative.\n\n## Décisions et pourquoi\nDécisions référencées.\n\n## Alternatives écartées\nRAS.\n\n## Implications\nRAS.\n\n## Points ouverts\nRAS.";
    },
  );

  let artifact = "";
  await runner.withHandoff(conversation.id, async (value) => {
    artifact = value.contentMd;
  });

  expect(prompts.some((prompt) => prompt.includes("HISTORIQUE DE DÉBRIEFS"))).toBe(true);
  expect(artifact).toContain("Synthèse cumulative");
  expect(artifact.length).toBeLessThan(120_000);
  db.close();
});

test("condense aussi un unique débrief historique déjà surdimensionné", async () => {
  const { db, projects, conversations, conversation } = setup();
  const eventId = conversations.appendEvent(conversation.id, {
    type: "text-final",
    text: "ancien lot",
  });
  const store = new DebriefStore(db);
  store.createWithReference({
    conversationId: conversation.id,
    eventIdFrom: eventId,
    eventIdTo: eventId,
    contentMd: `## Ce qui a été construit\n${"x".repeat(130_000)}\n\n## Décisions et pourquoi\nRAS.\n\n## Alternatives écartées\nRAS.\n\n## Implications\nRAS.\n\n## Points ouverts\nRAS.`,
  });
  let calls = 0;
  const runner = new DebriefRunner(
    store,
    conversations,
    projects,
    new QuotaTracker(db),
    () => {},
    async () => {
      calls += 1;
      return "## Ce qui a été construit\nSynthèse historique.\n\n## Décisions et pourquoi\nRAS.\n\n## Alternatives écartées\nRAS.\n\n## Implications\nRAS.\n\n## Points ouverts\nRAS.";
    },
  );

  let artifact = "";
  await runner.withHandoff(conversation.id, async (value) => {
    artifact = value.contentMd;
  });

  expect(calls).toBeGreaterThan(0);
  expect(artifact).toContain("Synthèse historique");
  expect(artifact.length).toBeLessThan(120_000);
  db.close();
});
