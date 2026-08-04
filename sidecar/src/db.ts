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
  // Les migrations de table (rebuild d'`events`) tournent clés étrangères
  // désactivées ; le PRAGMA est réactivé à la fin de openDb.
  db.exec(`
    PRAGMA foreign_keys = OFF;
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
    -- conversation_id porte SOIT un id de conversation SOIT un id de subtask :
    -- pas de clé étrangère, le replay par id reste identique dans les deux cas.
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      payload TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_conv ON events(conversation_id, id);
    CREATE TABLE IF NOT EXISTS quota_state (
      key TEXT PRIMARY KEY, value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS subtasks (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      provider TEXT NOT NULL, model TEXT NOT NULL,
      effort TEXT NULL, speed TEXT NULL,
      prompt TEXT NOT NULL, label TEXT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_subtasks_conv ON subtasks(conversation_id, created_at);
  `);
  dropEventsForeignKey(db);
  addColumn(db, "conversations", "effort TEXT NULL");
  addColumn(db, "conversations", "speed TEXT NULL");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function addColumn(db: Database, table: string, definition: string): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("duplicate column")) {
      throw error;
    }
  }
}

/**
 * Migration idempotente : les bases d'avant M2-D1 ont `events.conversation_id
 * REFERENCES conversations(id)`, ce qui interdit d'y stocker les événements
 * d'une subtask (dont l'id n'est pas une conversation). SQLite ne sait pas
 * retirer une contrainte : on reconstruit la table à l'identique sans elle.
 */
function dropEventsForeignKey(db: Database): void {
  const row = db
    .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'events'")
    .get() as { sql?: string } | null;
  if (!row?.sql?.includes("REFERENCES")) return;
  db.exec(`
    CREATE TABLE events_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      payload TEXT NOT NULL, created_at TEXT NOT NULL
    );
    INSERT INTO events_new (id, conversation_id, payload, created_at)
      SELECT id, conversation_id, payload, created_at FROM events;
    DROP TABLE events;
    ALTER TABLE events_new RENAME TO events;
    CREATE INDEX IF NOT EXISTS idx_events_conv ON events(conversation_id, id);
  `);
}
