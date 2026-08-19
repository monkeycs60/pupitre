import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";

function tables(db: ReturnType<typeof openDb>): string[] {
  return (db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>)
    .map((row) => row.name);
}

test("crée les tables du Tableau de bord et la colonne ticket_id", () => {
  const db = openDb(mkdtempSync(join(tmpdir(), "pupitre-db-tickets-")));
  const names = tables(db);
  expect(names).toEqual(expect.arrayContaining(["project_integrations", "tickets", "ticket_refs", "ticket_notes"]));
  const columns = (db.query("PRAGMA table_info(conversations)").all() as Array<{ name: string }>).map((c) => c.name);
  expect(columns).toContain("ticket_id");
});

test("une clé de ticket est unique par projet", () => {
  const db = openDb(mkdtempSync(join(tmpdir(), "pupitre-db-tickets-")));
  db.query("INSERT INTO projects (id, name, path, created_at) VALUES ('p1', 'p', '/tmp/p1', '2026-01-01')").run();
  const insert = db.query(
    "INSERT INTO tickets (id, project_id, key, source, title, status, external_url, updated_at, created_at) VALUES (?, 'p1', 'TECH-1', 'clickup', 't', 'open', NULL, '2026-01-01', '2026-01-01')",
  );
  insert.run("t1");
  expect(() => insert.run("t2")).toThrow();
});
