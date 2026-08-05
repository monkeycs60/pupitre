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
    CREATE TABLE IF NOT EXISTS presets (
      id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      provider TEXT NOT NULL, model TEXT NOT NULL,
      effort TEXT NULL, speed TEXT NULL,
      orchestrator INTEGER NOT NULL DEFAULT 1,
      built_in INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL
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
    CREATE TABLE IF NOT EXISTS debriefs (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      event_id_from INTEGER NOT NULL,
      event_id_to INTEGER NOT NULL,
      content_md TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_debriefs_conv
      ON debriefs(conversation_id, created_at, id);
    CREATE TABLE IF NOT EXISTS commit_links (
      commit_sha TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (commit_sha, project_id, conversation_id)
    );
    CREATE INDEX IF NOT EXISTS idx_commit_links_project
      ON commit_links(project_id, commit_sha, created_at);
    DELETE FROM commit_links
    WHERE rowid NOT IN (
      SELECT MIN(rowid) FROM commit_links GROUP BY project_id, commit_sha
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_commit_links_origin
      ON commit_links(project_id, commit_sha);
    CREATE TABLE IF NOT EXISTS test_inventories (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      event_id_from INTEGER NOT NULL,
      event_id_to INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_test_inventories_conversation
      ON test_inventories(conversation_id, created_at, id);
    CREATE TABLE IF NOT EXISTS test_scopes (
      id TEXT PRIMARY KEY,
      inventory_id TEXT NOT NULL REFERENCES test_inventories(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      methods_json TEXT NOT NULL,
      guardian_flag_ids TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'passed', 'failed')),
      subtask_id TEXT NULL,
      evidence_md TEXT NULL,
      images_json TEXT NOT NULL DEFAULT '[]',
      error TEXT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_test_scopes_inventory
      ON test_scopes(inventory_id, created_at, id);
    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      git_ref_base TEXT NOT NULL, git_ref_head TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running'
        CHECK (status IN ('running', 'done', 'error')),
      review_provider TEXT NOT NULL, review_model TEXT NOT NULL,
      review_effort TEXT NOT NULL, code_provider TEXT NULL,
      diff_text TEXT NOT NULL DEFAULT '', error TEXT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reviews_project
      ON reviews(project_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS review_flags (
      id TEXT PRIMARY KEY,
      review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
      file TEXT NOT NULL, line_start INTEGER NOT NULL, line_end INTEGER NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('red', 'orange', 'grey')),
      category TEXT NOT NULL, message TEXT NOT NULL,
      code_provider TEXT NULL,
      is_test_gap INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'acked', 'dismissed', 'countered'))
    );
    CREATE INDEX IF NOT EXISTS idx_review_flags_review
      ON review_flags(review_id, severity, line_start);
    CREATE TABLE IF NOT EXISTS review_decisions (
      id TEXT PRIMARY KEY,
      review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
      question TEXT NOT NULL, flag_ids TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'acked', 'dismissed'))
    );
    CREATE INDEX IF NOT EXISTS idx_review_decisions_review
      ON review_decisions(review_id, id);
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      triggers_json TEXT NOT NULL DEFAULT '[]',
      provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),
      provenance TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      project_id TEXT NULL REFERENCES projects(id) ON DELETE CASCADE,
      content_md TEXT NOT NULL,
      modified_at TEXT NOT NULL,
      indexed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_skills_provider_project
      ON skills(provider, project_id, name COLLATE NOCASE);
    CREATE TABLE IF NOT EXISTS skill_favorites (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, skill_id)
    );
    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      skill_id TEXT NULL REFERENCES skills(id) ON DELETE SET NULL,
      skill_name TEXT NOT NULL,
      skill_invocation TEXT NOT NULL,
      prompt TEXT NOT NULL,
      preset_id TEXT NULL REFERENCES presets(id) ON DELETE SET NULL,
      provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),
      model TEXT NOT NULL,
      effort TEXT NULL,
      speed TEXT NULL,
      orchestrator INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflows_project_name
      ON workflows(project_id, name COLLATE NOCASE);
  `);
  dropEventsForeignKey(db);
  addColumn(db, "conversations", "effort TEXT NULL");
  addColumn(db, "conversations", "speed TEXT NULL");
  // M2-D2 : une conversation orchestratrice reçoit le bridge MCP `conductor`.
  // Défaut ON — les conversations existantes en héritent aussi.
  addColumn(db, "conversations", "orchestrator INTEGER NOT NULL DEFAULT 1");
  addColumn(db, "conversations", "continued_from TEXT NULL");
  addColumn(db, "conversations", "handoff_pending INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "projects", "default_preset_id TEXT NULL");
  addColumn(db, "projects", "gardien_mode TEXT NOT NULL DEFAULT 'informatif'");
  addColumn(db, "projects", "auto_counter_red INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "reviews", "code_provider TEXT NULL");
  addColumn(db, "review_flags", "counter_state TEXT NOT NULL DEFAULT 'idle'");
  addColumn(db, "review_flags", "counter_verdict TEXT NULL");
  addColumn(db, "review_flags", "counter_text TEXT NULL");
  addColumn(db, "review_flags", "counter_provider TEXT NULL");
  addColumn(db, "review_flags", "counter_model TEXT NULL");
  addColumn(db, "review_flags", "counter_effort TEXT NULL");
  addColumn(db, "review_flags", "counter_subtask_id TEXT NULL");
  addColumn(db, "review_flags", "counter_error TEXT NULL");
  addColumn(db, "review_flags", "decision TEXT NULL");
  addColumn(db, "review_flags", "code_provider TEXT NULL");
  const addedTestGap = addColumn(
    db,
    "review_flags",
    "is_test_gap INTEGER NOT NULL DEFAULT 0",
  );
  if (addedTestGap) {
    // Les flags créés avant M3-I n'avaient pas de champ structuré. Cette
    // reprise unique conserve les alertes de tests déjà visibles dans Tester.
    db.exec(`
      UPDATE review_flags
      SET is_test_gap = 1
      WHERE lower(category || ' ' || message) LIKE '%test%'
        AND (
          lower(category || ' ' || message) LIKE '%absence%'
          OR lower(category || ' ' || message) LIKE '%manque%'
          OR lower(category || ' ' || message) LIKE '%sans%'
          OR lower(category || ' ' || message) LIKE '%non %'
          OR lower(category || ' ' || message) LIKE '%absent%'
          OR lower(category || ' ' || message) LIKE '%manquant%'
          OR lower(category || ' ' || message) LIKE '%critique%'
          OR lower(category || ' ' || message) LIKE '%couverture%'
          OR lower(category || ' ' || message) LIKE '%coverage%'
        )
    `);
  }
  addColumn(db, "test_scopes", "images_json TEXT NOT NULL DEFAULT '[]'");
  const addedReviewProvider = addColumn(
    db,
    "presets",
    "review_provider TEXT NOT NULL DEFAULT 'codex'",
  );
  addColumn(db, "presets", "review_model TEXT NOT NULL DEFAULT 'gpt-5.6-sol'");
  addColumn(db, "presets", "review_effort TEXT NOT NULL DEFAULT 'high'");
  if (addedReviewProvider) {
    // Lors du passage M2 → M3, un preset Claude hérite du reviewer fort Claude.
    // Cette correction ne tourne qu'à l'ajout de colonne et ne peut donc pas
    // écraser un choix utilisateur lors des démarrages suivants.
    db.exec(`
      UPDATE presets
      SET review_provider = 'claude', review_model = 'opus', review_effort = 'high'
      WHERE provider = 'claude'
    `);
  }
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function addColumn(db: Database, table: string, definition: string): boolean {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
    return true;
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("duplicate column")) {
      throw error;
    }
    return false;
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
