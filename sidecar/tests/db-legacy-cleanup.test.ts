import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";

function columns(db: ReturnType<typeof openDb>, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
}

test("retire les anciennes tables et colonnes du système de relecture", () => {
  const db = openDb(mkdtempSync(join(tmpdir(), "pupitre-cleanup-")));
  const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name);
  expect(tables).not.toContain("reviews");
  expect(tables).not.toContain("review_flags");
  expect(columns(db, "projects")).not.toContain("default_review_preset_id");
  expect(columns(db, "projects")).not.toContain("default_correction_preset_id");
  expect(columns(db, "test_scopes")).not.toContain("guardian_flag_ids");
  db.close();
});

test("retire les chantiers en gardant leurs conversations et leurs TODO", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pupitre-chantiers-"));
  const first = openDb(dir);
  const { ProjectStore } = await import("../src/stores/projects");
  const { ConversationStore } = await import("../src/stores/conversations");
  const project = new ProjectStore(first).create({ name: "Test", path: dir });
  const conversation = new ConversationStore(first).create({ projectId: project.id, provider: "claude", model: "test", firstMessage: "Moteur" });
  const now = new Date().toISOString();
  first.query(
    "INSERT INTO tickets (id, project_id, key, source, title, status, payload_json, created_at, updated_at, last_seen_at) VALUES ('ch1', ?, 'CH-1', 'chantier', 'Moteur Rust', '', '{}', ?, ?, ?)",
  ).run(project.id, now, now, now);
  first.query("INSERT INTO ticket_notes (id, ticket_id, body, created_at) VALUES ('n1', 'ch1', 'Note', ?)").run(now);
  first.query("UPDATE conversations SET ticket_id = 'ch1', ticket_locked = 1 WHERE id = ?").run(conversation.id);
  first.query("INSERT INTO project_todos (id, project_id, payload) VALUES ('t1', ?, json_object('ticket_id', 'ch1', 'title', 'Tâche'))").run(project.id);
  first.close();

  const db = openDb(dir);
  expect(db.query("SELECT COUNT(*) AS n FROM tickets").get()).toEqual({ n: 0 });
  expect(db.query("SELECT COUNT(*) AS n FROM ticket_notes").get()).toEqual({ n: 0 });
  expect(db.query("SELECT ticket_id, ticket_locked FROM conversations WHERE id = ?").get(conversation.id)).toEqual({ ticket_id: null, ticket_locked: 0 });
  expect(db.query("SELECT json_extract(payload, '$.ticket_id') AS ticket, json_extract(payload, '$.title') AS title FROM project_todos").get()).toEqual({ ticket: null, title: "Tâche" });
  expect(db.query("SELECT name FROM sqlite_master WHERE name = 'removed_chantiers'").get()).toBeNull();
  db.close();
});
