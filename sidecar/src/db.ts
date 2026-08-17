import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { countConversationMessages } from "./message-count";
import { MESSAGE_COUNT_MIGRATION_KEY, SPEED_REVIEW_MIGRATION_KEY } from "./stores/settings";

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
      filesystem_scope TEXT NOT NULL DEFAULT 'project-and-ai-roots',
      pinned INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
      default_review_preset_id TEXT NULL,
      default_correction_preset_id TEXT NULL
    );
    CREATE TABLE IF NOT EXISTS presets (
      id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      provider TEXT NOT NULL, model TEXT NOT NULL,
      effort TEXT NULL, speed TEXT NULL,
      orchestrator INTEGER NOT NULL DEFAULT 1,
      subagent_preset_id TEXT NULL REFERENCES presets(id) ON DELETE SET NULL,
      subagent_effort TEXT NULL,
      built_in INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
      title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
      provider TEXT NOT NULL, model TEXT NOT NULL,
      preset_id TEXT NULL REFERENCES presets(id) ON DELETE SET NULL,
      permission_mode TEXT NULL,
      subagent_preset_id TEXT NULL REFERENCES presets(id) ON DELETE SET NULL,
      subagent_effort TEXT NULL,
      cli_session_id TEXT, pinned INTEGER NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0,
      last_read_turn INTEGER NOT NULL DEFAULT 0,
      created_on_branch TEXT NULL,
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
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NULL,
      project_id TEXT NULL,
      conversation_title TEXT NULL,
      project_name TEXT NULL,
      title TEXT NOT NULL,
      summary TEXT NULL,
      kind TEXT NOT NULL DEFAULT 'html',
      mime_type TEXT NOT NULL DEFAULT 'text/html',
      original_name TEXT NOT NULL DEFAULT 'index.html',
      relative_path TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NULL,
      retained_at TEXT NULL,
      expired_at TEXT NULL,
      deleted_at TEXT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_documents_conversation
      ON documents(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_documents_project
      ON documents(project_id, created_at);
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
      review_effort TEXT NOT NULL, review_speed TEXT NOT NULL DEFAULT 'standard', code_provider TEXT NULL,
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
        CHECK (status IN ('open', 'agent_running', 'treated', 'ignored', 'resolved'))
    );
    CREATE INDEX IF NOT EXISTS idx_review_flags_review
      ON review_flags(review_id, severity, line_start);
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
    CREATE TABLE IF NOT EXISTS routines (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      schedule TEXT NOT NULL,
      workflow_id TEXT NULL REFERENCES workflows(id) ON DELETE SET NULL,
      prompt TEXT NULL,
      preset_id TEXT NULL REFERENCES presets(id) ON DELETE SET NULL,
      provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),
      model TEXT NOT NULL,
      effort TEXT NULL,
      speed TEXT NULL,
      orchestrator INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      next_run_at TEXT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_routines_project_name
      ON routines(project_id, name COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_routines_due
      ON routines(enabled, next_run_at);
    CREATE TABLE IF NOT EXISTS routine_runs (
      id TEXT PRIMARY KEY,
      routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
      conversation_id TEXT NULL REFERENCES conversations(id) ON DELETE SET NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'done', 'error')),
      error TEXT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_routine_runs_routine
      ON routine_runs(routine_id, started_at DESC);
    CREATE TABLE IF NOT EXISTS app_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      conversation_id TEXT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS gamification_activity (
      day TEXT PRIMARY KEY,
      active_ms INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS gamification_awards (
      source_key TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      project_id TEXT NULL REFERENCES projects(id) ON DELETE CASCADE,
      conversation_id TEXT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      base_xp INTEGER NOT NULL,
      multiplier REAL NOT NULL,
      xp INTEGER NOT NULL,
      day TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_gamification_awards_day
      ON gamification_awards(day, created_at);
  `);
  dropEventsForeignKey(db);
  migrateDocuments(db);
  addColumn(db, "conversations", "effort TEXT NULL");
  addColumn(db, "conversations", "speed TEXT NULL");
  addColumn(db, "conversations", "preset_id TEXT NULL REFERENCES presets(id) ON DELETE SET NULL");
  addColumn(db, "conversations", "permission_mode TEXT NULL");
  addColumn(db, "conversations", "summary TEXT NOT NULL DEFAULT ''");
  addColumn(db, "conversations", "archived INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "conversations", "deleted_at TEXT NULL");
  // M2-D2 : une conversation orchestratrice reçoit le bridge MCP `conductor`.
  // Défaut ON — les conversations existantes en héritent aussi.
  addColumn(db, "conversations", "orchestrator INTEGER NOT NULL DEFAULT 1");
  addColumn(db, "conversations", "subagent_preset_id TEXT NULL REFERENCES presets(id) ON DELETE SET NULL");
  addColumn(db, "conversations", "subagent_effort TEXT NULL");
  addColumn(db, "conversations", "continued_from TEXT NULL");
  addColumn(db, "conversations", "handoff_pending INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "conversations", "routine_id TEXT NULL");
  // Worktree dédié à la conversation ; NULL = dossier principal du projet, donc
  // le travail mono-branche ne change pas. Voir docs/adr/0001.
  addColumn(db, "conversations", "worktree_path TEXT NULL");
  // Un renommage manuel fige le titre : la régénération automatique le respecte.
  addColumn(db, "projects", "mcp_servers TEXT NULL");
  addColumn(db, "conversations", "title_locked INTEGER NOT NULL DEFAULT 0");
  // Nombre de tours au moment du dernier digest (0 = jamais généré).
  addColumn(db, "conversations", "digest_turn INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "conversations", "message_count INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "conversations", "last_read_turn INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "conversations", "created_on_branch TEXT NULL");
  migrateConversationMessageCounts(db);
  addColumn(db, "projects", "default_preset_id TEXT NULL");
  const addedDefaultReviewPreset = addColumn(db, "projects", "default_review_preset_id TEXT NULL");
  const addedDefaultCorrectionPreset = addColumn(db, "projects", "default_correction_preset_id TEXT NULL");
  if (addedDefaultReviewPreset || addedDefaultCorrectionPreset) {
    // Les anciens projets utilisaient le preset conversationnel comme défaut
    // du Gardien ; le recopier conserve leur comportement tout en séparant
    // désormais les trois usages dans les réglages.
    db.exec(`
      UPDATE projects
      SET default_review_preset_id = default_preset_id
      WHERE default_review_preset_id IS NULL AND default_preset_id IS NOT NULL;
      UPDATE projects
      SET default_correction_preset_id = default_preset_id
      WHERE default_correction_preset_id IS NULL AND default_preset_id IS NOT NULL;
    `);
  }
  addColumn(db, "projects", "filesystem_scope TEXT NOT NULL DEFAULT 'project-and-ai-roots'");
  addColumn(db, "projects", "auto_rescan INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "reviews", "code_provider TEXT NULL");
  addColumn(db, "reviews", "review_speed TEXT NOT NULL DEFAULT 'standard'");
  addColumn(db, "review_flags", "code_provider TEXT NULL");
  addColumn(db, "review_flags", "hunk_hash TEXT NULL");
  addColumn(db, "review_flags", "subtask_id TEXT NULL");
  addColumn(db, "review_flags", "user_message TEXT NULL");
  addColumn(db, "reviews", "scope TEXT NOT NULL DEFAULT 'worktree'");
  addColumn(db, "reviews", "parent_review_id TEXT NULL");
  const addedTestGap = addColumn(
    db,
    "review_flags",
    "is_test_gap INTEGER NOT NULL DEFAULT 0",
  );
  // Les bases historiques n'ont pas encore `is_test_gap` : la reconstruction
  // de la contrainte de statut doit donc se produire après cet ajout.
  migrateReviewFlagStatuses(db);
  // Résidus de l'ancien mode Gardien informatif/bloquant, supprimé par la
  // refonte « calque Git » — les bases historiques les portent encore.
  dropColumn(db, "projects", "gardien_mode");
  dropColumn(db, "review_flags", "decision");
  // Résidu du contre-avis, jamais utilisé (M3-J) — les bases historiques
  // portent encore ces colonnes et l'option projet.
  db.exec("UPDATE review_flags SET status = 'open' WHERE status = 'countered'");
  dropColumn(db, "review_flags", "counter_state");
  dropColumn(db, "review_flags", "counter_verdict");
  dropColumn(db, "review_flags", "counter_text");
  dropColumn(db, "review_flags", "counter_provider");
  dropColumn(db, "review_flags", "counter_model");
  dropColumn(db, "review_flags", "counter_effort");
  dropColumn(db, "review_flags", "counter_subtask_id");
  dropColumn(db, "review_flags", "counter_error");
  dropColumn(db, "projects", "auto_counter_red");
  // Résidu de la review et du rescan automatique par conversation, remplacés
  // par les presets de review/correction du projet, résolus côté serveur.
  dropColumn(db, "conversations", "auto_review");
  dropColumn(db, "conversations", "review_provider");
  dropColumn(db, "conversations", "review_model");
  dropColumn(db, "conversations", "review_effort");
  dropColumn(db, "conversations", "review_speed");
  // Migration de vocabulaire : « acquitté/écarté » devient « traité/ignoré ».
  db.exec("UPDATE review_flags SET status = 'treated' WHERE status = 'acked'");
  db.exec("UPDATE review_flags SET status = 'ignored' WHERE status = 'dismissed'");
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
  const addedRoutineTokens = addColumn(
    db,
    "routine_runs",
    "tokens INTEGER NOT NULL DEFAULT 0",
  );
  if (addedRoutineTokens) {
    db.exec(`
      UPDATE routine_runs
      SET tokens = COALESCE((
        SELECT SUM(
          COALESCE(json_extract(events.payload, '$.inputTokens'), 0)
          + COALESCE(json_extract(events.payload, '$.outputTokens'), 0)
        )
        FROM events
        WHERE events.conversation_id = routine_runs.conversation_id
          AND json_valid(events.payload)
          AND json_extract(events.payload, '$.type') = 'usage'
      ), 0)
    `);
  }
  const addedReviewProvider = addColumn(
    db,
    "presets",
    "review_provider TEXT NOT NULL DEFAULT 'codex'",
  );
  addColumn(db, "presets", "review_model TEXT NOT NULL DEFAULT 'gpt-5.6-sol'");
  addColumn(db, "presets", "review_effort TEXT NOT NULL DEFAULT 'high'");
  addColumn(db, "presets", "subagent_preset_id TEXT NULL REFERENCES presets(id) ON DELETE SET NULL");
  addColumn(db, "presets", "subagent_effort TEXT NULL");
  // Marqueur d'héritage : sans lui, une configuration de review égale aux
  // anciens defaults est indiscernable d'un choix délibéré identique.
  const addedReviewExplicit = addColumn(
    db,
    "presets",
    "review_explicit INTEGER NOT NULL DEFAULT 0",
  );
  if (addedReviewExplicit && !addedReviewProvider) {
    // La base porte déjà des reviews saisies sans marqueur : on les déclare
    // explicites, faute de pouvoir les distinguer d'un héritage. Préserver un
    // héritage coûte un réglage à refaire ; écraser un choix le perd.
    db.exec("UPDATE presets SET review_explicit = 1");
  }
  if (addedReviewProvider) {
    // Lors du passage M2 → M3, aucune review n'a encore pu être choisie : tout
    // ce qui existe est un héritage, donc alignable sans risque. Un preset
    // Claude hérite du reviewer fort Claude, un preset personnalisé de sa
    // propre configuration.
    db.exec(`
      UPDATE presets
      SET review_provider = 'claude', review_model = 'opus', review_effort = 'high'
      WHERE provider = 'claude'
    `);
    // `effort` peut être NULL sur un preset personnalisé : le laisser de côté
    // abandonnerait son reviewer aux anciens defaults Codex. On retombe alors
    // sur l'effort par défaut du provider.
    db.exec(`
      UPDATE presets
      SET review_provider = provider,
          review_model = model,
          review_effort = COALESCE(effort, 'high')
      WHERE built_in = 0
    `);
  }
  const speedReviewMigrated = db.query("SELECT 1 AS present FROM settings WHERE key = ?")
    .get(SPEED_REVIEW_MIGRATION_KEY);
  if (!speedReviewMigrated) {
    // L'ancien preset Vitesse utilisait Sol/high pour Gardien alors que son nom
    // désigne le réglage Luna rapide du chat. On répare une seule fois le preset.
    db.exec(`
      UPDATE presets
      SET review_provider = provider, review_model = model, review_effort = effort
      WHERE id = 'builtin-speed'
        AND review_provider = 'codex'
        AND review_model = 'gpt-5.6-sol'
        AND review_effort = 'high';
    `);
    db.query("INSERT INTO settings (key, value) VALUES (?, ?)")
      .run(SPEED_REVIEW_MIGRATION_KEY, "1");
  }
  db.exec("DROP TABLE IF EXISTS review_decisions");
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

function dropColumn(db: Database, table: string, column: string): void {
  const columns = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  }
}


function migrateConversationMessageCounts(db: Database): void {
  const migrated = db.query("SELECT 1 FROM settings WHERE key = ?")
    .get(MESSAGE_COUNT_MIGRATION_KEY);
  if (migrated) return;

  const conversations = db.query("SELECT id FROM conversations").all() as Array<{ id: string }>;
  const events = db.query(
    "SELECT payload FROM events WHERE conversation_id = ? ORDER BY id",
  );
  const update = db.query("UPDATE conversations SET message_count = ? WHERE id = ?");

  for (const conversation of conversations) {
    const parsedEvents: Array<{ type?: string }> = [];
    for (const row of events.all(conversation.id) as Array<{ payload: string }>) {
      try {
        parsedEvents.push(JSON.parse(row.payload) as { type?: string });
      } catch {
        // Les événements invalides ne peuvent pas représenter un message.
      }
    }
    update.run(countConversationMessages(parsedEvents), conversation.id);
  }

  db.query("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
    .run(MESSAGE_COUNT_MIGRATION_KEY, "1");
}

function migrateDocuments(db: Database): void {
  const legacy = db.query(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'html_documents'",
  ).get() as { present: number } | null;
  if (legacy) {
    addColumn(db, "html_documents", "kind TEXT NOT NULL DEFAULT 'html'");
    addColumn(db, "html_documents", "mime_type TEXT NOT NULL DEFAULT 'text/html'");
    addColumn(db, "html_documents", "original_name TEXT NOT NULL DEFAULT 'index.html'");
    db.exec(`
      INSERT OR IGNORE INTO documents (
        id, conversation_id, project_id, conversation_title, project_name,
        title, summary, kind, mime_type, original_name, relative_path,
        size_bytes, sha256, created_at, expires_at, retained_at, expired_at, deleted_at
      )
      SELECT d.id, d.conversation_id, c.project_id, c.title, p.name,
        d.title, d.summary, d.kind, d.mime_type, d.original_name, d.relative_path,
        d.size_bytes, d.sha256, d.created_at, d.expires_at, d.retained_at,
        d.expired_at, d.deleted_at
      FROM html_documents d
      LEFT JOIN conversations c ON c.id = d.conversation_id
      LEFT JOIN projects p ON p.id = c.project_id
    `);
  }

  // À partir de cette migration, tout document encore disponible devient
  // permanent. Les tombstones déjà expirées restent dans l'historique.
  db.exec(`
    UPDATE documents
    SET retained_at = COALESCE(retained_at, created_at), expires_at = NULL
    WHERE expired_at IS NULL AND deleted_at IS NULL
  `);

  // L'index contient sa propre copie du texte : la provenance reste donc
  // recherchable même si la conversation ou le projet source est supprimé.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
      document_id UNINDEXED,
      title,
      summary,
      project_name,
      conversation_title,
      body,
      tokenize = 'unicode61 remove_diacritics 2'
    )
  `);
}

// Le CHECK reconstruit ici garde 'countered' volontairement : sur une base
// qui passe encore par cette étape, des lignes peuvent porter ce statut — il
// n'est neutralisé en 'open' que par la migration suivante (voir plus bas
// dans migrate(), juste avant les dropColumn de counter_*).
function migrateReviewFlagStatuses(db: Database): void {
  const sql = (db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'review_flags'")
    .get() as { sql?: string } | null)?.sql ?? "";
  if (!sql.includes("'acked'")) return;
  db.exec(`
    CREATE TABLE review_flags_new (
      id TEXT PRIMARY KEY,
      review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
      file TEXT NOT NULL, line_start INTEGER NOT NULL, line_end INTEGER NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('red', 'orange', 'grey')),
      category TEXT NOT NULL, message TEXT NOT NULL,
      code_provider TEXT NULL, is_test_gap INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'countered', 'agent_running', 'treated', 'ignored', 'resolved')),
      counter_state TEXT NOT NULL DEFAULT 'idle', counter_verdict TEXT NULL,
      counter_text TEXT NULL, counter_provider TEXT NULL, counter_model TEXT NULL,
      counter_effort TEXT NULL, counter_subtask_id TEXT NULL, counter_error TEXT NULL,
      hunk_hash TEXT NULL, subtask_id TEXT NULL, user_message TEXT NULL
    );
    INSERT INTO review_flags_new
    SELECT id, review_id, file, line_start, line_end, severity, category, message,
      code_provider, is_test_gap,
      CASE status WHEN 'acked' THEN 'treated' WHEN 'dismissed' THEN 'ignored' ELSE status END,
      counter_state, counter_verdict, counter_text, counter_provider, counter_model,
      counter_effort, counter_subtask_id, counter_error, hunk_hash, subtask_id, user_message
    FROM review_flags;
    DROP TABLE review_flags;
    ALTER TABLE review_flags_new RENAME TO review_flags;
    CREATE INDEX IF NOT EXISTS idx_review_flags_review
      ON review_flags(review_id, severity, line_start);
  `);
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
