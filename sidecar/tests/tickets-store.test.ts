import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { ConversationStore } from "../src/stores/conversations";
import { ProjectStore } from "../src/stores/projects";
import { TicketStore } from "../src/stores/tickets";

let tickets: TicketStore;
let conversations: ConversationStore;
let projectId: string;

beforeEach(() => {
  const db = openDb(mkdtempSync(join(tmpdir(), "pupitre-tickets-")));
  projectId = new ProjectStore(db).create({ name: "mono", path: "/tmp/mono" }).id;
  conversations = new ConversationStore(db);
  tickets = new TicketStore(db);
});

test("upsert par clé : crée puis met à jour sans changer l'id", () => {
  const a = tickets.upsert(projectId, {
    key: "TECH-1",
    source: "clickup",
    title: "Un",
    status: "open",
    externalUrl: "https://x/1",
  });
  const b = tickets.upsert(projectId, {
    key: "TECH-1",
    source: "clickup",
    title: "Un bis",
    status: "in progress",
    externalUrl: "https://x/1",
  });

  expect(b.id).toBe(a.id);
  expect(b.title).toBe("Un bis");
  expect(b.status).toBe("in progress");
  expect(b.archived_at).toBeNull();
});

test("un ticket git ne réécrit pas le titre d'un ticket clickup existant", () => {
  tickets.upsert(projectId, {
    key: "TECH-2",
    source: "clickup",
    title: "Vrai titre",
    status: "open",
    externalUrl: null,
  });
  const again = tickets.upsert(projectId, {
    key: "TECH-2",
    source: "git",
    title: "feature/TECH-2",
    status: "",
    externalUrl: null,
  });

  expect(again.source).toBe("clickup");
  expect(again.title).toBe("Vrai titre");
});

test("références : upsert par (kind, ref), payload remplacé, lecture groupée", () => {
  const ticket = tickets.upsert(projectId, {
    key: "TECH-3",
    source: "git",
    title: "b",
    status: "",
    externalUrl: null,
  });

  tickets.upsertRef(ticket.id, {
    kind: "mr",
    ref: "Affilae/symfony!1862",
    payload: { status: "opened" },
  });
  tickets.upsertRef(ticket.id, {
    kind: "mr",
    ref: "Affilae/symfony!1862",
    payload: { status: "merged" },
  });
  tickets.upsertRef(ticket.id, {
    kind: "branch",
    ref: "feature/TECH-3",
    payload: {},
  });

  const refs = tickets.refsByTicket(ticket.id);
  expect(refs).toHaveLength(2);
  expect(refs.find((row) => row.kind === "mr")?.payload).toEqual({ status: "merged" });
});

test("archive les tickets non vus depuis 14 jours, réveille ceux revus", () => {
  const old = tickets.upsert(projectId, {
    key: "TECH-4",
    source: "git",
    title: "b",
    status: "",
    externalUrl: null,
  });

  tickets.touchSeen(old.id, "2026-01-01T00:00:00.000Z");
  expect(tickets.archiveStale(projectId, new Date("2026-02-01T00:00:00.000Z"))).toBe(1);
  expect(tickets.get(old.id)?.archived_at).not.toBeNull();

  tickets.upsert(projectId, {
    key: "TECH-4",
    source: "git",
    title: "b",
    status: "",
    externalUrl: null,
  });
  expect(tickets.get(old.id)?.archived_at).toBeNull();
});

test("touchSeen réactive un ticket déjà archivé", () => {
  const ticket = tickets.upsert(projectId, {
    key: "TECH-4B",
    source: "git",
    title: "b",
    status: "",
    externalUrl: null,
  });

  tickets.touchSeen(ticket.id, "2026-01-01T00:00:00.000Z");
  expect(tickets.archiveStale(projectId, new Date("2026-01-20T00:00:00.000Z"))).toBe(1);
  expect(tickets.get(ticket.id)?.archived_at).not.toBeNull();

  tickets.touchSeen(ticket.id, "2026-01-21T00:00:00.000Z");
  expect(tickets.get(ticket.id)?.archived_at).toBeNull();
  expect(tickets.get(ticket.id)?.last_seen_at).toBe("2026-01-21T00:00:00.000Z");
});

test("archiveStale archive aussi un ticket vu exactement il y a 14 jours", () => {
  const ticket = tickets.upsert(projectId, {
    key: "TECH-4C",
    source: "git",
    title: "b",
    status: "",
    externalUrl: null,
  });

  tickets.touchSeen(ticket.id, "2026-01-18T00:00:00.000Z");
  expect(tickets.archiveStale(projectId, new Date("2026-02-01T00:00:00.000Z"))).toBe(1);
  expect(tickets.get(ticket.id)?.archived_at).toBe("2026-02-01T00:00:00.000Z");
});

test("notes et liaison de conversation", () => {
  const ticket = tickets.upsert(projectId, {
    key: "TECH-5",
    source: "git",
    title: "b",
    status: "",
    externalUrl: null,
  });

  const note = tickets.addNote(ticket.id, "penser au cache");
  expect(tickets.notesByTicket(ticket.id)).toEqual([note]);

  const conversation = conversations.create({
    projectId,
    provider: "claude",
    model: "m",
    firstMessage: "x",
    ticketId: ticket.id,
  });

  expect(conversation.ticket_id).toBe(ticket.id);
  expect(tickets.conversationsByTicket(ticket.id).map((row) => row.id)).toEqual([conversation.id]);
  expect(conversations.listByProject(projectId)[0]?.ticket_key).toBe("TECH-5");
});

test("listByProject rend les tickets actifs avec refs et compteurs", () => {
  const ticket = tickets.upsert(projectId, {
    key: "TECH-6",
    source: "clickup",
    title: "b",
    status: "open",
    externalUrl: null,
  });

  tickets.upsertRef(ticket.id, {
    kind: "branch",
    ref: "feature/TECH-6",
    payload: {},
  });
  conversations.create({
    projectId,
    provider: "claude",
    model: "m",
    firstMessage: "x",
    ticketId: ticket.id,
  });

  const rows = tickets.listByProject(projectId);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.refs).toHaveLength(1);
  expect(rows[0]?.conversations).toHaveLength(1);
});
