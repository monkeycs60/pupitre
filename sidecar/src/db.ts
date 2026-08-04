import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export function dataDir(): string {
  return process.env.PUPITRE_DATA_DIR ?? join(homedir(), ".local/share/pupitre");
}

export function openDb(dir: string = dataDir()): Database {
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "media"), { recursive: true });
  const db = new Database(join(dir, "pupitre.db"));
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
      permission_mode TEXT NOT NULL DEFAULT 'acceptEdits',
      pinned INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
      title TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
      cli_session_id TEXT, pinned INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      payload TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_conv ON events(conversation_id, id);
  `);
  try {
    db.exec("ALTER TABLE conversations ADD COLUMN effort TEXT NULL");
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("duplicate column")) {
      throw error;
    }
  }
  try {
    db.exec("ALTER TABLE conversations ADD COLUMN speed TEXT NULL");
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("duplicate column")) {
      throw error;
    }
  }
  return db;
}
