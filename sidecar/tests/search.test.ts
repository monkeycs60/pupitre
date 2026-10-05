import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DebriefStore } from "../src/stores/debriefs";
import { openDb } from "../src/db";
import { SearchIndex } from "../src/search";
import { ConversationStore } from "../src/stores/conversations";
import { TicketStore } from "../src/stores/tickets";
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

test("recherche les tickets et les branches, suit les rattachements et masque les projets retirés", () => {
  const db = openDb(mkdtempSync(join(tmpdir(), "pupitre-search-tickets-")));
  const projects = new ProjectStore(db);
  const conversations = new ConversationStore(db);
  const tickets = new TicketStore(db);
  const project = projects.create({ name: "Mono", path: "/tmp/mono" });
  const conversation = conversations.create({ projectId: project.id, provider: "codex", model: "test", firstMessage: "Travail", createdOnBranch: "feature/cartographie" });
  const ticket = tickets.upsert(project.id, { key: "TECH-25267", title: "Ciblage géographique", source: "clickup", status: "open", externalUrl: null });
  const search = new SearchIndex(db);
  tickets.linkConversation(conversation.id, ticket.id);
  expect(search.search("tech 25267 geographique")[0]?.conversationId).toBe(conversation.id);
  expect(search.search("cartographie")[0]?.conversationId).toBe(conversation.id);
  tickets.upsert(project.id, { key: ticket.key, title: "Audience régionale", source: "clickup", status: "open", externalUrl: null });
  expect(search.search("audience regionale")[0]?.conversationId).toBe(conversation.id);
  projects.remove(project.id);
  expect(search.search("audience")).toEqual([]);
  db.close();
});

test("changer de ticket ne réindexe que la conversation ; changer de titre réindexe ses messages", () => {
  const db = openDb(mkdtempSync(join(tmpdir(), "pupitre-search-triggers-")));
  const project = new ProjectStore(db).create({ name: "Index", path: "/tmp/index" });
  const conversations = new ConversationStore(db);
  const tickets = new TicketStore(db);
  const conversation = conversations.create({ projectId: project.id, provider: "codex", model: "test", firstMessage: "Départ" });
  conversations.appendEvent(conversation.id, { type: "user-message", text: "Le pangolin dort", images: [] });
  conversations.appendEvent(conversation.id, { type: "text-final", text: "Le pangolin mange" });
  const later = conversations.create({ projectId: project.id, provider: "codex", model: "test", firstMessage: "Ailleurs" });
  conversations.appendEvent(later.id, { type: "text-final", text: "Autre sujet" });
  const search = new SearchIndex(db);
  const eventRows = () => db.query("SELECT rowid, title FROM search_index WHERE kind = 'event' AND conversation_id = ? ORDER BY rowid").all(conversation.id) as Array<{ rowid: number; title: string }>;
  const before = eventRows();
  expect(before).toHaveLength(2);

  const ticket = tickets.upsert(project.id, { key: "TECH-7", title: "Zoologie", source: "clickup", status: "open", externalUrl: null });
  tickets.linkConversation(conversation.id, ticket.id);
  conversations.updateDigest(conversation.id, { title: conversation.title, summary: "Résumé sur les fourmiliers" }, 1);
  expect(eventRows()).toEqual(before);
  expect(search.search("zoologie")[0]?.conversationId).toBe(conversation.id);
  expect(search.search("fourmiliers")[0]?.conversationId).toBe(conversation.id);
  expect(db.query("SELECT COUNT(*) AS n FROM search_index WHERE kind = 'conversation' AND conversation_id = ?").get(conversation.id)).toEqual({ n: 1 });

  conversations.rename(conversation.id, "Étude du pangolin");
  const renamed = eventRows();
  expect(renamed).toHaveLength(2);
  expect(renamed.every((row) => row.title === "Étude du pangolin")).toBe(true);
  expect(search.search("zoologie")[0]?.conversationId).toBe(conversation.id);
  db.close();
});
