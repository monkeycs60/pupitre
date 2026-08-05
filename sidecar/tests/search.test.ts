import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DebriefStore } from "../src/stores/debriefs";
import { openDb } from "../src/db";
import { SearchIndex } from "../src/search";
import { ConversationStore } from "../src/stores/conversations";
import { ProjectStore } from "../src/stores/projects";

test("backfill puis indexation continue des conversations, events et débriefs", () => {
  const dir = mkdtempSync(join(tmpdir(), "pupitre-search-"));
  const db = openDb(dir);
  const projects = new ProjectStore(db);
  const conversations = new ConversationStore(db);
  const project = projects.create({ name: "Recherche", path: dir });
  const historical = conversations.create({
    projectId: project.id,
    provider: "codex",
    model: "gpt-5.6-luna",
    firstMessage: "Migration historique",
  });
  conversations.appendEvent(historical.id, { type: "text-final", text: "Ornithorynque ancien" });

  const search = new SearchIndex(db);
  expect(search.search("ornithorynque")[0]).toMatchObject({
    kind: "event",
    conversationId: historical.id,
    projectId: project.id,
  });

  conversations.appendEvent(historical.id, {
    type: "user-message",
    text: "Analyse la nébuleuse",
    images: [],
  });
  new DebriefStore(db).createWithReference({
    conversationId: historical.id,
    eventIdFrom: 1,
    eventIdTo: 2,
    contentMd: "Décision : conserver le quartz bleu.",
  });

  expect(search.search("nebuleuse")[0]).toMatchObject({ kind: "event" });
  expect(search.search("quartz")[0]).toMatchObject({ kind: "debrief" });
  expect(search.search("migration", project.id)[0]).toMatchObject({ kind: "conversation" });
  expect(search.search("migration", "projet-inconnu")).toEqual([]);
});
