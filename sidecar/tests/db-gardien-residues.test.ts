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

test("le contre-avis et auto_counter_red ne laissent aucune colonne", () => {
  const db = openDb(mkdtempSync(join(tmpdir(), "pupitre-db-")));
  const flagColumns = columns(db, "review_flags");
  for (const name of ["counter_state", "counter_verdict", "counter_text", "counter_provider", "counter_model", "counter_effort", "counter_subtask_id", "counter_error"]) {
    expect(flagColumns).not.toContain(name);
  }
  const projectColumns = columns(db, "projects");
  expect(projectColumns).not.toContain("auto_counter_red");
  db.close();
});

test("la review et le rescan par conversation ne laissent aucune colonne", () => {
  const db = openDb(mkdtempSync(join(tmpdir(), "pupitre-db-")));
  const conversationColumns = columns(db, "conversations");
  for (const name of ["auto_review", "review_provider", "review_model", "review_effort", "review_speed"]) {
    expect(conversationColumns).not.toContain(name);
  }
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
