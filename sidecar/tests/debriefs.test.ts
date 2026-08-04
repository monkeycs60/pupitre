import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { DebriefRunner } from "../src/debriefs";
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
      return "## Décisions et pourquoi\nSQLite.\n\n## Alternatives écartées\nPostgres.\n\n## Implications\nLocal.\n\n## Points ouverts\nAucun.";
    },
  );

  const debrief = await runner.generate(conversation.id);

  expect(debrief.event_id_from).toBe(firstId);
  expect(debrief.event_id_to).toBe(lastId);
  expect(capturedPrompt).toContain("événement #" + firstId);
  expect(capturedPrompt).toContain("SQLite plutôt que Postgres");
  expect(new DebriefStore(db).listByConversation(conversation.id)).toEqual([debrief]);
  expect(conversations.listEvents(conversation.id).at(-1)).toEqual(
    expect.objectContaining({ type: "debrief-ref", debriefId: debrief.id }),
  );
  expect(broadcasts).toHaveLength(1);
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
      return "## Décisions et pourquoi\nDécision.\n\n## Alternatives écartées\nAucune.\n\n## Implications\nRAS.\n\n## Points ouverts\nAucun.";
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
  db.close();
});
