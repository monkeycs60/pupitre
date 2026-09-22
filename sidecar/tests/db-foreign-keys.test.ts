import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";

type Db = ReturnType<typeof openDb>;

function tableSql(db: Db, table: string): string {
  return (db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string }).sql;
}

function danglingReferences(db: Db): string[] {
  const tables = new Set((db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
    .map((row) => row.name));
  return (db.query("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql LIKE '%REFERENCES%'").all() as Array<{ name: string; sql: string }>)
    .flatMap((row) => [...row.sql.matchAll(/REFERENCES\s+"?(\w+)"?/g)]
      .map((match) => match[1])
      .filter((target) => !tables.has(target))
      .map((target) => `${row.name} -> ${target}`));
}

/** Reproduit l'ancienne reconstruction, qui renommait la table d'origine. */
function renameRebuild(db: Db, table: string, staging: string): void {
  const sql = tableSql(db, table);
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(`ALTER TABLE ${table} RENAME TO ${staging}`);
  db.exec(sql);
  db.exec(`INSERT INTO ${table} SELECT * FROM ${staging}`);
  db.exec(`DROP TABLE ${staging}`);
}

test("répare les clés étrangères laissées vers une table de migration supprimée", () => {
  const dir = mkdtempSync(join(tmpdir(), "pupitre-fk-"));
  const broken = openDb(dir);
  renameRebuild(broken, "skills", "skills__grok_provider");
  renameRebuild(broken, "workflows", "workflows__grok_provider");
  renameRebuild(broken, "routines", "routines__grok_provider");
  expect(danglingReferences(broken).length).toBeGreaterThan(0);
  broken.close();

  const db = openDb(dir);
  expect(danglingReferences(db)).toEqual([]);
  expect(() => db.query("DELETE FROM routines WHERE id = 'x'").run()).not.toThrow();
  expect(() => db.query("DELETE FROM workflows WHERE id = 'x'").run()).not.toThrow();
  expect(() => db.query("DELETE FROM projects WHERE id = 'x'").run()).not.toThrow();
  expect(db.query("SELECT count(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'idx_routines_due'").get())
    .toEqual({ n: 1 });
  db.close();
});

test("élargir la contrainte de provider ne casse pas les clés étrangères des autres tables", () => {
  const dir = mkdtempSync(join(tmpdir(), "pupitre-fk-widen-"));
  const legacy = openDb(dir);
  const sql = tableSql(legacy, "routines");
  legacy.exec("PRAGMA foreign_keys = OFF");
  legacy.exec(sql.replace(/^CREATE TABLE\s+(?:"[^"]+"|\w+)/i, 'CREATE TABLE "routines_old"')
    .replace("CHECK (provider IN ('claude', 'codex', 'grok', 'reasonix'))", "CHECK (provider IN ('claude', 'codex'))"));
  legacy.exec("DROP TABLE routines");
  legacy.exec("ALTER TABLE routines_old RENAME TO routines");
  expect(tableSql(legacy, "routines")).toContain("CHECK (provider IN ('claude', 'codex'))");
  legacy.close();

  const db = openDb(dir);
  expect(tableSql(db, "routines")).toContain("'reasonix'");
  expect(danglingReferences(db)).toEqual([]);
  db.close();
});
