import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";

function tables(db: ReturnType<typeof openDb>): string[] {
  return (db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>)
    .map((row) => row.name);
}

function columns(db: ReturnType<typeof openDb>, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
}

test("crée les tables domains et conversation_domains", () => {
  const db = openDb(mkdtempSync(join(tmpdir(), "pupitre-db-domains-")));
  expect(tables(db)).toEqual(expect.arrayContaining(["domains", "conversation_domains"]));
  expect(columns(db, "domains")).toEqual(expect.arrayContaining([
    "id", "project_id", "name", "kind", "status", "created_at", "updated_at",
  ]));
  expect(columns(db, "conversation_domains")).toEqual(expect.arrayContaining([
    "conversation_id", "domain_id", "origin", "created_at",
  ]));
});

test("un nom de domaine est unique par projet, insensible à la casse", () => {
  const db = openDb(mkdtempSync(join(tmpdir(), "pupitre-db-domains-unique-")));
  db.query("INSERT INTO projects (id, name, path, created_at) VALUES ('p1', 'p', '/tmp/p1', '2026-01-01')").run();
  db.query(
    "INSERT INTO domains (id, project_id, name, kind, status, created_at, updated_at) VALUES ('d1', 'p1', 'API', 'technique', 'proposé', '2026-01-01', '2026-01-01')",
  ).run();
  expect(() => db.query(
    "INSERT INTO domains (id, project_id, name, kind, status, created_at, updated_at) VALUES ('d2', 'p1', 'api', 'technique', 'proposé', '2026-01-01', '2026-01-01')",
  ).run()).toThrow();
});

test("une association conversation-domaine est unique", () => {
  const db = openDb(mkdtempSync(join(tmpdir(), "pupitre-db-domains-assoc-")));
  db.query("INSERT INTO projects (id, name, path, created_at) VALUES ('p1', 'p', '/tmp/p1', '2026-01-01')").run();
  db.query(
    "INSERT INTO conversations (id, project_id, title, provider, model, created_at, updated_at) VALUES ('c1', 'p1', 't', 'claude', 'm', '2026-01-01', '2026-01-01')",
  ).run();
  db.query(
    "INSERT INTO domains (id, project_id, name, kind, status, created_at, updated_at) VALUES ('d1', 'p1', 'API', 'technique', 'actif', '2026-01-01', '2026-01-01')",
  ).run();
  const insert = db.query(
    "INSERT INTO conversation_domains (conversation_id, domain_id, origin, created_at) VALUES ('c1', 'd1', 'auto', '2026-01-01')",
  );
  insert.run();
  expect(() => insert.run()).toThrow();
});
