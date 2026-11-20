import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { NoteStore, openNotesPreamble } from "../src/stores/notes";
import { ProjectStore } from "../src/stores/projects";
import { TicketStore } from "../src/stores/tickets";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pupitre-notes-"));
  const db = openDb(dir);
  const projects = new ProjectStore(db);
  const project = projects.create({ name: "mono", path: join(dir, "mono") });
  const other = projects.create({ name: "autre", path: join(dir, "autre") });
  const tickets = new TicketStore(db);
  const ticket = tickets.upsert(project.id, { key: "TECH-1", source: "clickup", title: "Un", status: "", externalUrl: null });
  const sibling = tickets.upsert(project.id, { key: "feature/x", source: "git", title: "x", status: "", externalUrl: null });
  return { dir, db, project, other, tickets, ticket, sibling, notes: new NoteStore(db) };
}

test("une conversation voit les notes de son ticket et de son projet, pas celles d'un autre ticket ni d'un autre projet", () => {
  const { project, other, ticket, sibling, notes } = setup();
  const onTicket = notes.create({ projectId: project.id, ticketId: ticket.id, body: "Brancher le worker", author: "user", conversationId: null });
  const onProject = notes.create({ projectId: project.id, ticketId: null, body: "Relancer la doc", author: "agent", conversationId: null });
  notes.create({ projectId: project.id, ticketId: sibling.id, body: "Autre ticket", author: "user", conversationId: null });
  notes.create({ projectId: other.id, ticketId: null, body: "Autre projet", author: "user", conversationId: null });

  expect(notes.listFor(project.id, ticket.id).map((note) => note.id)).toEqual([onTicket.id, onProject.id]);
  expect(notes.listFor(project.id, null).map((note) => note.id)).toEqual([onProject.id]);
  expect(onProject).toMatchObject({ author: "agent", ticket_id: null, done_at: null });
});

test("cocher, décocher, modifier et supprimer une note ; notes_count ne compte que les notes ouvertes", () => {
  const { project, tickets, ticket, notes } = setup();
  const first = notes.create({ projectId: project.id, ticketId: ticket.id, body: "Un", author: "user", conversationId: null });
  notes.create({ projectId: project.id, ticketId: ticket.id, body: "Deux", author: "user", conversationId: null });
  expect(tickets.listByProject(project.id).find((row) => row.id === ticket.id)?.notes_count).toBe(2);

  const done = notes.update(first.id, { done: true })!;
  expect(done.done_at).not.toBeNull();
  expect(notes.update(first.id, { done: true })!.done_at).toBe(done.done_at);
  expect(tickets.listByProject(project.id).find((row) => row.id === ticket.id)?.notes_count).toBe(1);

  expect(notes.update(first.id, { done: false })!.done_at).toBeNull();
  expect(notes.update(first.id, { body: "Un bis" })!.body).toBe("Un bis");
  expect(notes.delete(first.id)?.id).toBe(first.id);
  expect(notes.get(first.id)).toBeNull();
  expect(notes.delete(first.id)).toBeNull();
  expect(notes.update("inconnue", { done: true })).toBeNull();
});

test("la suppression d'un ticket emporte ses notes, pas celles du projet", () => {
  const { db, project, ticket, notes } = setup();
  notes.create({ projectId: project.id, ticketId: ticket.id, body: "Ticket", author: "user", conversationId: null });
  notes.create({ projectId: project.id, ticketId: null, body: "Projet", author: "user", conversationId: null });
  db.query("DELETE FROM tickets WHERE id = ?").run(ticket.id);
  expect(notes.listFor(project.id, ticket.id).map((note) => note.body)).toEqual(["Projet"]);
});

test("migration : les lignes de ticket_notes passent dans notes, une seule fois", () => {
  const { dir, db, project, ticket } = setup();
  db.exec(`
    CREATE TABLE ticket_notes (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  db.query("INSERT INTO ticket_notes VALUES ('n1', ?, 'Avant prod : brancher le worker', '2026-11-20T13:36:54.156Z')").run(ticket.id);
  db.query("INSERT INTO ticket_notes VALUES ('n2', ?, 'Avant prod : pièces jointes', '2026-11-20T13:36:54.162Z')").run(ticket.id);
  db.close();

  const migrated = openDb(dir);
  expect(migrated.query("SELECT name FROM sqlite_master WHERE name = 'ticket_notes'").get()).toBeNull();
  const rows = new NoteStore(migrated).listFor(project.id, ticket.id);
  expect(rows).toEqual([
    {
      id: "n1", project_id: project.id, ticket_id: ticket.id, body: "Avant prod : brancher le worker",
      author: "user", conversation_id: null, done_at: null, created_at: "2026-11-20T13:36:54.156Z",
    },
    {
      id: "n2", project_id: project.id, ticket_id: ticket.id, body: "Avant prod : pièces jointes",
      author: "user", conversation_id: null, done_at: null, created_at: "2026-11-20T13:36:54.162Z",
    },
  ]);
  new NoteStore(migrated).delete("n2");
  migrated.close();

  const reopened = openDb(dir);
  expect((reopened.query("SELECT id FROM notes").all() as Array<{ id: string }>).map((row) => row.id)).toEqual(["n1"]);
  reopened.close();
});

test("le bloc du premier tour liste les notes ouvertes avec leur portée et leur id", () => {
  const { project, ticket, notes } = setup();
  expect(openNotesPreamble([], "TECH-1")).toBeNull();
  const onTicket = notes.create({ projectId: project.id, ticketId: ticket.id, body: "Brancher\nle worker", author: "user", conversationId: null });
  const onProject = notes.create({ projectId: project.id, ticketId: null, body: "Relancer la doc", author: "user", conversationId: null });
  const done = notes.create({ projectId: project.id, ticketId: null, body: "Déjà fait", author: "user", conversationId: null });
  notes.update(done.id, { done: true });

  const block = openNotesPreamble(notes.listFor(project.id, ticket.id), "TECH-1")!;
  expect(block.split("\n")).toEqual([
    "## Notes ouvertes avant déploiement",
    expect.stringContaining("`complete_note`"),
    `- Ticket TECH-1 · Brancher le worker (id ${onTicket.id})`,
    `- Projet · Relancer la doc (id ${onProject.id})`,
  ]);
  expect(openNotesPreamble(notes.listFor(project.id, ticket.id).filter((note) => note.done_at !== null), null)).toBeNull();
});
