import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";

function columns(db: ReturnType<typeof openDb>, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map((item) => item.name);
}

test("une base neuve ne porte plus decision ni gardien_mode", () => {
  const db = openDb(mkdtempSync(join(tmpdir(), "pupitre-db-")));
  expect(columns(db, "projects")).not.toContain("gardien_mode");
  expect(columns(db, "review_flags")).not.toContain("decision");
  db.close();
});

test("une base historique voit ses colonnes résiduelles purgées à l'ouverture", () => {
  const dir = mkdtempSync(join(tmpdir(), "pupitre-db-"));
  const first = openDb(dir);
  // Rejoue l'état d'avant la refonte « calque Git ».
  first.exec("ALTER TABLE projects ADD COLUMN gardien_mode TEXT NOT NULL DEFAULT 'informatif'");
  first.exec("ALTER TABLE review_flags ADD COLUMN decision TEXT NULL");
  expect(columns(first, "projects")).toContain("gardien_mode");
  first.close();

  const reopened = openDb(dir);
  expect(columns(reopened, "projects")).not.toContain("gardien_mode");
  expect(columns(reopened, "review_flags")).not.toContain("decision");
  reopened.close();
});
