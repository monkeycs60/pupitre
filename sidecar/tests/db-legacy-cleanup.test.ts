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
