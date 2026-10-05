import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { countConversationMessages } from "./message-count";
import { isBaseBranch } from "./ticket-key";
import {
  MESSAGE_COUNT_MIGRATION_KEY,
  OBSOLETE_MODELS_MIGRATION_KEY,
  SOL_61_MIGRATION_KEY,
  PROJECT_LAUNCH_CONFIG_MIGRATION_KEY,
  QUALITY_FABLE_51_MIGRATION_KEY,
  SettingsStore,
  SPEED_REVIEW_MIGRATION_KEY,
  TICKET_AUDIT_YOLO_MIGRATION_KEY,
  TRUNK_TICKETS_MIGRATION_KEY,
} from "./stores/settings";
import { defaultDataDir, readInstance } from "./instance";
import { BUILT_INS } from "./stores/presets";
import { PROJECT_COLORS } from "./stores/projects";

export function dataDir(): string {
  return process.env.PUPITRE_DATA_DIR ?? defaultDataDir(readInstance().name);
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
    -- En WAL, FULL imposait un fsync par transaction — donc par événement
    -- appendé pendant le streaming. NORMAL ne risque qu'un retour en arrière
    -- de quelques transactions sur coupure de courant, jamais une corruption.
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS project_todos (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
      permission_mode TEXT NOT NULL DEFAULT 'acceptEdits',
      filesystem_scope TEXT NOT NULL DEFAULT 'project-and-ai-roots',
      pinned INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
      default_scout_preset_id TEXT NULL,
      default_todo_preset_id TEXT NULL
    );
    CREATE TABLE IF NOT EXISTS presets (
      id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      provider TEXT NOT NULL, model TEXT NOT NULL,
      effort TEXT NULL, speed TEXT NULL,
      built_in INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS settings_value_json_insert
      BEFORE INSERT ON settings
      WHEN json_valid(NEW.value) = 0
      BEGIN
        SELECT RAISE(ABORT, 'settings.value doit contenir du JSON valide');
      END;
    CREATE TRIGGER IF NOT EXISTS settings_value_json_update
      BEFORE UPDATE OF value ON settings
      WHEN json_valid(NEW.value) = 0
      BEGIN
        SELECT RAISE(ABORT, 'settings.value doit contenir du JSON valide');
      END;
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
      title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
      provider TEXT NOT NULL, model TEXT NOT NULL,
      preset_id TEXT NULL REFERENCES presets(id) ON DELETE SET NULL,
      permission_mode TEXT NULL,
      cli_session_id TEXT, pinned INTEGER NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0,
      last_read_turn INTEGER NOT NULL DEFAULT 0,
      answered_turn INTEGER NOT NULL DEFAULT 0,
      created_on_branch TEXT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    -- conversation_id porte SOIT un id de conversation SOIT un id de subtask :
    -- pas de clé étrangère, le replay par id reste identique dans les deux cas.
    CREATE TABLE IF NOT EXISTS visual_feedback_origins (
      origin TEXT NOT NULL,
      path_prefix TEXT NOT NULL DEFAULT '/',
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      PRIMARY KEY (origin, path_prefix)
    );
    CREATE TABLE IF NOT EXISTS visual_feedback_submissions (
      submission_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL
    );
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
    CREATE TABLE IF NOT EXISTS project_integrations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('clickup', 'gitlab', 'github', 'notion', 'sentry')),
      config_json TEXT NOT NULL DEFAULT '{}',
      branch_pattern TEXT NULL,
      status TEXT NOT NULL DEFAULT 'non configurée'
        CHECK (status IN ('ok', 'dégradée', 'hors ligne', 'non configurée', 'à reconfigurer')),
      last_ok_at TEXT NULL,
      last_error TEXT NULL,
      snapshot_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (project_id, type)
    );
    CREATE TABLE IF NOT EXISTS integration_secrets (
      integration_id TEXT NOT NULL REFERENCES project_integrations(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (integration_id, name)
    );
    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('clickup', 'notion', 'git', 'chantier')),
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT '',
      external_url TEXT NULL,
      instruction TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL DEFAULT '{}',
      last_seen_at TEXT NOT NULL DEFAULT '',
      archived_at TEXT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (project_id, key)
    );
    CREATE INDEX IF NOT EXISTS idx_tickets_project ON tickets(project_id, archived_at, updated_at);
    CREATE TABLE IF NOT EXISTS ticket_refs (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('branch', 'mr', 'pipeline', 'deployment', 'sentry_issue')),
      ref TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      seen_at TEXT NOT NULL,
      UNIQUE (ticket_id, kind, ref)
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_refs_ticket ON ticket_refs(ticket_id, kind);
    CREATE TABLE IF NOT EXISTS ticket_status_changes (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL,
      from_status TEXT NOT NULL,
      to_status TEXT NOT NULL,
      changed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_status_changes_project ON ticket_status_changes(project_id, changed_at);
    CREATE TABLE IF NOT EXISTS ticket_notes (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_notes_ticket ON ticket_notes(ticket_id, created_at);
    CREATE TABLE IF NOT EXISTS problem_captures (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      raw_text TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'done', 'error')),
      error TEXT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_problem_captures_project
      ON problem_captures(project_id, status, created_at DESC);
    CREATE TABLE IF NOT EXISTS problems (
      id TEXT PRIMARY KEY,
      public_id TEXT NOT NULL UNIQUE,
      capture_id TEXT NOT NULL REFERENCES problem_captures(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      ticket_id TEXT NULL REFERENCES tickets(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      context TEXT NOT NULL,
      resolution TEXT NOT NULL,
      plans_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
      closed_at TEXT NULL,
      closed_commit_sha TEXT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_problems_project
      ON problems(project_id, status, created_at DESC);
    CREATE TABLE IF NOT EXISTS problem_missions (
      id TEXT PRIMARY KEY,
      public_id TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_problem_missions_project
      ON problem_missions(project_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS problem_mission_items (
      mission_id TEXT NOT NULL REFERENCES problem_missions(id) ON DELETE CASCADE,
      problem_id TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (mission_id, problem_id),
      UNIQUE (mission_id, position)
    );
    CREATE INDEX IF NOT EXISTS idx_problem_mission_items_problem
      ON problem_mission_items(problem_id, mission_id);
    CREATE TABLE IF NOT EXISTS problem_axis_runs (
      id TEXT PRIMARY KEY,
      problem_id TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
      plan_index INTEGER NOT NULL,
      mission_id TEXT NULL REFERENCES problem_missions(id) ON DELETE CASCADE,
      conversation_id TEXT NULL REFERENCES conversations(id) ON DELETE SET NULL,
      status TEXT NOT NULL CHECK (status IN (
        'running', 'interrupted', 'failed', 'awaiting_validation', 'completed', 'abandoned'
      )),
      error TEXT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_problem_axis_runs_problem
      ON problem_axis_runs(problem_id, plan_index, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_problem_axis_runs_mission
      ON problem_axis_runs(mission_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_problem_axis_runs_conversation
      ON problem_axis_runs(conversation_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS attention_items (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      source_key TEXT NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      target_json TEXT NOT NULL DEFAULT '{}',
      condition_version TEXT NOT NULL,
      acknowledged_version TEXT NULL,
      resolved_at TEXT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (type, source_key)
    );
    CREATE INDEX IF NOT EXISTS idx_attention_items_open
      ON attention_items(project_id, resolved_at, updated_at DESC);
    CREATE TABLE IF NOT EXISTS conversation_links (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('sidequest')),
      source_conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      source_event_id INTEGER NULL,
      target_conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_conversation_links_source
      ON conversation_links(source_conversation_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS changelog_reviews (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      summary_id TEXT NOT NULL UNIQUE,
      event_id_from INTEGER NOT NULL,
      event_id_to INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('proposé', 'publié')),
      changes_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      published_at TEXT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_changelog_reviews_conversation
      ON changelog_reviews(conversation_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS project_changelog_entries (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      repository_path TEXT NOT NULL DEFAULT '.',
      commit_sha TEXT NOT NULL,
      branch TEXT NOT NULL,
      subject TEXT NOT NULL,
      committed_at TEXT NOT NULL,
      product_message TEXT NULL,
      enrichment_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (enrichment_status IN ('pending', 'enriched')),
      imported_at TEXT NOT NULL,
      enriched_at TEXT NULL,
      PRIMARY KEY (project_id, commit_sha)
    );
    CREATE INDEX IF NOT EXISTS idx_project_changelog_entries_date
      ON project_changelog_entries(project_id, committed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_project_changelog_entries_pending
      ON project_changelog_entries(project_id, enrichment_status, committed_at DESC);
    CREATE TABLE IF NOT EXISTS project_changelog_state (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'error')),
      last_started_at TEXT NULL,
      last_refreshed_at TEXT NULL,
      next_refresh_at TEXT NULL,
      error TEXT NULL
    );
    CREATE TABLE IF NOT EXISTS sentry_issues (
      id TEXT PRIMARY KEY,
      integration_id TEXT NOT NULL REFERENCES project_integrations(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      sentry_issue_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      relevance_json TEXT NOT NULL DEFAULT '{"matched":false,"reasons":[]}',
      lifecycle TEXT NOT NULL CHECK (lifecycle IN ('new','active','quiet','resolved_remote')),
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      last_scanned_at TEXT NOT NULL,
      UNIQUE (integration_id, sentry_issue_id)
    );
    CREATE INDEX IF NOT EXISTS idx_sentry_issues_project
      ON sentry_issues(project_id, lifecycle, last_seen_at DESC);
    CREATE TABLE IF NOT EXISTS sentry_triages (
      issue_id TEXT PRIMARY KEY REFERENCES sentry_issues(id) ON DELETE CASCADE,
      conversation_id TEXT NULL REFERENCES conversations(id) ON DELETE SET NULL,
      correction_conversation_id TEXT NULL REFERENCES conversations(id) ON DELETE SET NULL,
      ticket_id TEXT NULL REFERENCES tickets(id) ON DELETE SET NULL,
      status TEXT NOT NULL CHECK (status IN ('idle','running','done','error')),
      verdict TEXT NULL CHECK (verdict IN ('real_fixable','real_investigate','noise','uncertain')),
      report_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
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
    CREATE TABLE IF NOT EXISTS conversation_push_acknowledgements (
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      commit_sha TEXT NOT NULL,
      acknowledged_at TEXT NOT NULL,
      PRIMARY KEY (conversation_id, commit_sha)
    );
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
    CREATE TABLE IF NOT EXISTS ticket_audits (
      ticket_id TEXT PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
      conversation_id TEXT NULL REFERENCES conversations(id) ON DELETE SET NULL,
      state TEXT NOT NULL CHECK (state IN ('reserved', 'running', 'done', 'error')),
      error TEXT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      triggers_json TEXT NOT NULL DEFAULT '[]',
      provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex', 'grok')),
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
      provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex', 'grok', 'reasonix')),
      model TEXT NOT NULL,
      effort TEXT NULL,
      speed TEXT NULL,
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
      provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex', 'grok', 'reasonix')),
      model TEXT NOT NULL,
      effort TEXT NULL,
      speed TEXT NULL,
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
    -- Vestiges du système d'XP, plus alimentés : gamification_activity sert
    -- encore de source à la reprise d'historique de time_entries.
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
    CREATE TABLE IF NOT EXISTS time_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_key TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      conversation_id TEXT NULL REFERENCES conversations(id) ON DELETE SET NULL,
      source TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      day TEXT NOT NULL,
      backfilled INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_time_entries_scope
      ON time_entries(project_id, source, started_at);
    CREATE INDEX IF NOT EXISTS idx_time_entries_conversation
      ON time_entries(conversation_id, source);
    -- Suspensions du process : veille machine, hibernation, gel. Elles se
    -- retranchent des tours, qui sinon mesureraient le sommeil de la machine.
    CREATE TABLE IF NOT EXISTS system_suspensions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL UNIQUE,
      ended_at TEXT NOT NULL
    );
    -- Rapport d'activité quotidien : un document par jour actif, et l'état de
    -- recul (motifs + preuves) que chaque passe met à jour sans le recalculer.
    CREATE TABLE IF NOT EXISTS activity_reports (
      day TEXT PRIMARY KEY,
      generated_at TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS activity_motifs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('recurrence', 'stabilize', 'practice', 'idea')),
      title TEXT NOT NULL,
      statement TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('open', 'stabilized', 'dismissed', 'handled')),
      first_seen_day TEXT NOT NULL,
      last_seen_day TEXT NOT NULL,
      returned_at TEXT NULL,
      dismissed_at TEXT NULL,
      todo_id TEXT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_activity_motifs_project
      ON activity_motifs(project_id, status, last_seen_day DESC);
    CREATE TABLE IF NOT EXISTS activity_motif_evidence (
      motif_id TEXT NOT NULL REFERENCES activity_motifs(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('conversation', 'commit', 'ticket', 'problem')),
      ref TEXT NOT NULL,
      project_id TEXT NOT NULL,
      label TEXT NOT NULL,
      day TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (motif_id, kind, ref)
    );
    CREATE TABLE IF NOT EXISTS activity_state (
      key TEXT PRIMARY KEY, value TEXT NOT NULL
    );
  `);
  migrateProjectChangelogEntries(db);
  dropEventsForeignKey(db);
  migrateDocuments(db);
  addColumn(db, "conversations", "effort TEXT NULL");
  addColumn(db, "conversations", "speed TEXT NULL");
  addColumn(db, "conversations", "preset_id TEXT NULL REFERENCES presets(id) ON DELETE SET NULL");
  addColumn(db, "conversations", "permission_mode TEXT NULL");
  addColumn(db, "conversations", "summary TEXT NOT NULL DEFAULT ''");
  addColumn(db, "conversations", "archived INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "conversations", "deleted_at TEXT NULL");
  addColumn(db, "conversations", "continued_from TEXT NULL");
  addColumn(db, "conversations", "handoff_pending INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "conversations", "routine_id TEXT NULL");
  // Worktree dédié à la conversation ; NULL = dossier principal du projet, donc
  // le travail mono-branche ne change pas. Voir docs/adr/0001.
  addColumn(db, "conversations", "worktree_path TEXT NULL");
  addColumn(db, "conversations", "worktree_paths TEXT NOT NULL DEFAULT '[]'");
  // Un renommage manuel fige le titre : la régénération automatique le respecte.
  addColumn(db, "projects", "chantiers_enabled INTEGER NOT NULL DEFAULT 1");
  addColumn(db, "conversations", "ticket_locked INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "conversations", "ticket_confidence REAL NULL");
  addColumn(db, "routines", "operation TEXT NULL");
  addColumn(db, "routines", "kind TEXT NOT NULL DEFAULT 'prompt'");
  addColumn(db, "routines", "command TEXT NULL");
  addColumn(db, "routine_runs", "output TEXT NULL");
  addColumn(db, "routine_runs", "exit_code INTEGER NULL");
  addColumn(db, "routine_runs", "duration_ms INTEGER NULL");
  addColumn(db, "projects", "trunk_branch TEXT NULL");
  addColumn(db, "projects", "sort_order INTEGER NULL");
  addColumn(db, "projects", "removed_at TEXT NULL");
  addColumn(db, "projects", "mcp_servers TEXT NULL");
  addColumn(db, "projects", "icon TEXT NULL");
  addColumn(db, "projects", "archived_at TEXT NULL");
  addColumn(db, "projects", "appearance_version INTEGER NOT NULL DEFAULT 0");
  if (addColumn(db, "projects", "color TEXT NULL")) assignMissingProjectColors(db);
  addColumn(db, "conversations", "title_locked INTEGER NOT NULL DEFAULT 0");
  // Nombre de tours au moment du dernier digest (0 = jamais généré).
  addColumn(db, "conversations", "digest_turn INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "conversations", "ticket_id TEXT NULL REFERENCES tickets(id) ON DELETE SET NULL");
  addColumn(db, "project_changelog_entries", "lines_added INTEGER NULL");
  addColumn(db, "project_changelog_entries", "lines_removed INTEGER NULL");
  addColumn(db, "project_changelog_entries", "is_merge INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "conversations", "ticket_instruction TEXT NULL");
  db.exec("CREATE INDEX IF NOT EXISTS idx_conversations_ticket ON conversations(ticket_id)");
  const addedTicketInstruction = addColumn(db, "tickets", "instruction TEXT NOT NULL DEFAULT ''");
  if (addedTicketInstruction) {
    db.exec(`
      UPDATE tickets
      SET instruction = COALESCE((
        SELECT group_concat(body, char(10) || char(10))
        FROM ticket_notes
        WHERE ticket_notes.ticket_id = tickets.id
        ORDER BY created_at
      ), '')
    `);
  }
  addColumn(db, "conversations", "message_count INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "conversations", "last_read_turn INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "conversations", "answered_turn INTEGER NOT NULL DEFAULT 0");
  db.exec(`CREATE INDEX IF NOT EXISTS idx_conversations_project_state
    ON conversations(project_id, archived, deleted_at, pinned, updated_at DESC)`);
  addColumn(db, "conversations", "created_on_branch TEXT NULL");
  addColumn(db, "conversations", "origin_type TEXT NULL");
  addColumn(db, "conversations", "origin_key TEXT NULL");
  migrateConversationMessageCounts(db);
  addColumn(db, "projects", "default_preset_id TEXT NULL");
  const addedDefaultScoutPreset = addColumn(db, "projects", "default_scout_preset_id TEXT NULL");
  if (addedDefaultScoutPreset) db.exec("UPDATE projects SET default_scout_preset_id = default_preset_id WHERE default_scout_preset_id IS NULL");
  addColumn(db, "projects", "default_todo_preset_id TEXT NULL");
  addColumn(db, "projects", "default_launch_config TEXT NULL");
  addColumn(db, "projects", "scout_launch_config TEXT NULL");
  addColumn(db, "projects", "todo_launch_config TEXT NULL");
  addColumn(db, "projects", "filesystem_scope TEXT NOT NULL DEFAULT 'project-and-ai-roots'");
  addColumn(db, "projects", "auto_rescan INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "project_changelog_state", "backfill_version INTEGER NOT NULL DEFAULT 0");
  dropColumn(db, "projects", "default_review_preset_id");
  dropColumn(db, "projects", "default_correction_preset_id");
  dropColumn(db, "test_scopes", "guardian_flag_ids");
  db.exec("DROP TABLE IF EXISTS review_flags; DROP TABLE IF EXISTS reviews;");
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
  // `default` laissait le CLI demander une permission que personne ne pouvait
  // accorder en headless : le tour lisait et répondait sans jamais agir. Le
  // rang a disparu ; les réglages qui le portaient tombent sur `plan`, qui
  // décrit ce comportement au lieu de le subir.
  db.exec("UPDATE projects SET permission_mode = 'plan' WHERE permission_mode = 'default'");
  db.exec("UPDATE conversations SET permission_mode = 'plan' WHERE permission_mode = 'default'");
  // La colonne appartient au PresetStore, qui l'ajoute à l'ouverture : sur une
  // base neuve elle n'existe pas encore, et aucune ligne n'est à réécrire.
  if (hasColumn(db, "presets", "permission_mode")) {
    db.exec("UPDATE presets SET permission_mode = 'plan' WHERE permission_mode = 'default'");
  }
  // La délégation de sous-tâches au modèle principal a été retirée : les
  // colonnes survivraient sinon aux `SELECT *` des stores, qui les rendraient
  // encore dans les réponses de l'API.
  dropColumn(db, "conversations", "orchestrator");
  dropColumn(db, "conversations", "subagent_preset_id");
  dropColumn(db, "conversations", "subagent_effort");
  dropColumn(db, "presets", "orchestrator");
  dropColumn(db, "presets", "subagent_preset_id");
  dropColumn(db, "presets", "subagent_effort");
  dropColumn(db, "workflows", "orchestrator");
  dropColumn(db, "routines", "orchestrator");
  const qualityFableMigrated = db.query("SELECT 1 AS present FROM settings WHERE key = ?")
    .get(QUALITY_FABLE_51_MIGRATION_KEY);
  if (!qualityFableMigrated) {
    db.exec(`
      UPDATE presets
      SET model = 'fable-5.1'
      WHERE id = 'builtin-quality'
        AND provider = 'claude'
        AND model = 'fable-5'
    `);
    new SettingsStore(db).set(QUALITY_FABLE_51_MIGRATION_KEY, true);
  }
  const obsoleteModelsMigrated = db.query("SELECT 1 AS present FROM settings WHERE key = ?")
    .get(OBSOLETE_MODELS_MIGRATION_KEY);
  if (!obsoleteModelsMigrated) {
    for (const table of ["presets", "workflows", "routines"]) {
      db.exec(`
        UPDATE ${table} SET model = 'gpt-6-luna', effort = 'xhigh' WHERE model = 'gpt-5.6-luna';
        UPDATE ${table} SET model = 'gpt-6.1-sol', effort = 'high' WHERE model IN ('gpt-5.6-sol', 'gpt-5.6-terra');
        UPDATE ${table} SET model = 'opus-5.5' WHERE model = 'opus';
      `);
    }
    new SettingsStore(db).set(OBSOLETE_MODELS_MIGRATION_KEY, true);
  }
  if (!db.query("SELECT 1 AS present FROM settings WHERE key = ?").get(PROJECT_LAUNCH_CONFIG_MIGRATION_KEY)) {
    migrateProjectLaunchConfigs(db);
    new SettingsStore(db).set(PROJECT_LAUNCH_CONFIG_MIGRATION_KEY, true);
  }
  if (!db.query("SELECT 1 AS present FROM settings WHERE key = ?").get(SOL_61_MIGRATION_KEY)) {
    migrateSol61(db);
  }
  if (!db.query("SELECT 1 AS present FROM settings WHERE key = ?").get(TICKET_AUDIT_YOLO_MIGRATION_KEY)) {
    db.exec(`
      UPDATE conversations
      SET permission_mode = 'bypassPermissions'
      WHERE permission_mode = 'acceptEdits'
        AND id IN (SELECT conversation_id FROM ticket_audits WHERE conversation_id IS NOT NULL)
    `);
    new SettingsStore(db).set(TICKET_AUDIT_YOLO_MIGRATION_KEY, true);
  }
  if (!db.query("SELECT 1 AS present FROM settings WHERE key = ?").get(TRUNK_TICKETS_MIGRATION_KEY)) {
    migrateTrunkTickets(db);
  }
  db.exec("DROP TABLE IF EXISTS review_decisions");
  const integrationSchema = db.query("SELECT sql FROM sqlite_master WHERE name='project_integrations'").get() as {sql:string};
  if (!integrationSchema.sql.includes("'telegram'")) db.transaction(() => rebuildTable(db, "project_integrations", integrationSchema.sql.replace("'notion', 'sentry'", "'notion', 'sentry', 'telegram'")))();
  const ticketSchema = db.query("SELECT sql FROM sqlite_master WHERE name='tickets'").get() as { sql: string };
  if (!ticketSchema.sql.includes("'chantier'")) db.transaction(() => {
    const triggers = db.query("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name!='tickets' AND sql LIKE '%tickets%'").all() as Array<{name:string;sql:string}>;
    for (const trigger of triggers) db.exec(`DROP TRIGGER "${trigger.name}"`);
    rebuildTable(db, "tickets", ticketSchema.sql.replace("'notion', 'git'", "'notion', 'git', 'chantier'"));
    for (const trigger of triggers) db.exec(trigger.sql);
  })();
  widenProviderCheck(db, "skills");
  widenProviderCheck(db, "workflows");
  widenProviderCheck(db, "routines");
  repairStagingForeignKeys(db);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_skills_provider_project
      ON skills(provider, project_id, name COLLATE NOCASE);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflows_project_name
      ON workflows(project_id, name COLLATE NOCASE);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_routines_project_name
      ON routines(project_id, name COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_routines_due
      ON routines(enabled, next_run_at);
  `);
  const legacyRelevance = db.query("SELECT id, relevance_json FROM sentry_issues WHERE relevance_json LIKE '%\"domain\"%'").all() as Array<{ id: string; relevance_json: string }>;
  for (const issue of legacyRelevance) {
    const previous = JSON.parse(issue.relevance_json) as { reasons?: Array<{ domain?: string; signal?: string }> };
    const reasons = (previous.reasons ?? []).flatMap((reason) => reason.domain?.startsWith("Ticket ") ? [{ ticket: reason.domain.slice(7), signal: reason.signal ?? "" }] : []);
    db.query("UPDATE sentry_issues SET relevance_json = ? WHERE id = ?").run(JSON.stringify({ matched: reasons.length > 0, reasons }), issue.id);
  }
  const changelogColumns = db.query("PRAGMA table_info(project_changelog_entries)").all() as Array<{ name: string }>;
  if (changelogColumns.some((column) => column.name === "domain_id")) db.exec("ALTER TABLE project_changelog_entries DROP COLUMN domain_id");
  db.exec("DROP TABLE IF EXISTS conversation_domains; DROP TABLE IF EXISTS domain_changes; DROP TABLE IF EXISTS domain_publications; DROP TABLE IF EXISTS domains;");
  removeChantiers(db);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

/**
 * Les chantiers ont été retirés de Pupitre. Chacun est copié dans
 * `removed_chantiers` (ticket, notes, conversations et TODO rattachées) avant
 * d'être supprimé ; les conversations et les TODO restent, sans rattachement.
 */
function removeChantiers(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS removed_chantiers (
    ticket_id TEXT PRIMARY KEY, ticket TEXT NOT NULL, notes TEXT NOT NULL,
    conversation_ids TEXT NOT NULL, todo_ids TEXT NOT NULL, removed_at TEXT NOT NULL
  )`);
  const chantiers = db.query("SELECT * FROM tickets WHERE source = 'chantier'").all() as Array<Record<string, unknown> & { id: string }>;
  const hasCaptures = db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='telegram_captures'").get();
  const removedAt = new Date().toISOString();
  db.transaction(() => {
    for (const chantier of chantiers) {
      const notes = db.query("SELECT body, created_at FROM ticket_notes WHERE ticket_id = ?").all(chantier.id);
      const conversations = db.query("SELECT id FROM conversations WHERE ticket_id = ?").all(chantier.id) as Array<{ id: string }>;
      const todos = db.query("SELECT id FROM project_todos WHERE json_extract(payload, '$.ticket_id') = ?").all(chantier.id) as Array<{ id: string }>;
      db.query("INSERT OR REPLACE INTO removed_chantiers VALUES (?, ?, ?, ?, ?, ?)").run(
        chantier.id, JSON.stringify(chantier), JSON.stringify(notes),
        JSON.stringify(conversations.map((row) => row.id)), JSON.stringify(todos.map((row) => row.id)), removedAt,
      );
      db.query("UPDATE conversations SET ticket_id = NULL, ticket_locked = 0, ticket_confidence = NULL WHERE ticket_id = ?").run(chantier.id);
      db.query("UPDATE project_todos SET payload = json_set(payload, '$.ticket_id', NULL) WHERE json_extract(payload, '$.ticket_id') = ?").run(chantier.id);
      if (hasCaptures) db.query("UPDATE telegram_captures SET ticket_id = NULL WHERE ticket_id = ?").run(chantier.id);
      for (const table of ["ticket_refs", "ticket_status_changes", "ticket_notes", "ticket_audits"]) {
        db.query(`DELETE FROM ${table} WHERE ticket_id = ?`).run(chantier.id);
      }
      for (const table of ["problems", "sentry_triages"]) {
        db.query(`UPDATE ${table} SET ticket_id = NULL WHERE ticket_id = ?`).run(chantier.id);
      }
      db.query("DELETE FROM tickets WHERE id = ?").run(chantier.id);
    }
    db.exec("DROP TABLE IF EXISTS chantier_reviews; DROP TABLE IF EXISTS chantier_sequences;");
    db.exec("DELETE FROM settings WHERE key = 'chantierIdleDays' OR key LIKE 'chantiers.%'");
  })();
}

function assignMissingProjectColors(db: Database): void {
  const rows = db.query(
    "SELECT id FROM projects WHERE color IS NULL ORDER BY sort_order IS NULL, sort_order ASC, created_at ASC",
  ).all() as { id: string }[];
  const update = db.query("UPDATE projects SET color = ? WHERE id = ?");
  rows.forEach((row, index) => update.run(PROJECT_COLORS[index % PROJECT_COLORS.length]!, row.id));
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

function migrateProjectChangelogEntries(db: Database): void {
  const columns = db.query("PRAGMA table_info(project_changelog_entries)").all() as Array<{
    name: string;
    pk: number;
  }>;
  const repositoryColumn = columns.find((column) => column.name === "repository_path");
  const primaryKey = columns.filter((column) => column.pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map((column) => column.name);
  if (repositoryColumn && primaryKey.join(",") === "project_id,commit_sha") return;

  db.exec(`
    CREATE TABLE project_changelog_entries_v2 (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      repository_path TEXT NOT NULL DEFAULT '.',
      commit_sha TEXT NOT NULL,
      branch TEXT NOT NULL,
      subject TEXT NOT NULL,
      committed_at TEXT NOT NULL,
      product_message TEXT NULL,
      enrichment_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (enrichment_status IN ('pending', 'enriched')),
      imported_at TEXT NOT NULL,
      enriched_at TEXT NULL,
      PRIMARY KEY (project_id, commit_sha)
    );
    INSERT OR IGNORE INTO project_changelog_entries_v2
      (project_id, repository_path, commit_sha, branch, subject, committed_at,
       product_message, enrichment_status, imported_at, enriched_at)
    SELECT project_id, '.', commit_sha, branch, subject, committed_at,
           product_message, enrichment_status, imported_at, enriched_at
    FROM project_changelog_entries
    ORDER BY CASE enrichment_status WHEN 'enriched' THEN 0 ELSE 1 END, imported_at;
    DROP TABLE project_changelog_entries;
    ALTER TABLE project_changelog_entries_v2 RENAME TO project_changelog_entries;
    CREATE INDEX idx_project_changelog_entries_date
      ON project_changelog_entries(project_id, committed_at DESC);
    CREATE INDEX idx_project_changelog_entries_pending
      ON project_changelog_entries(project_id, enrichment_status, committed_at DESC);
  `);
}

function widenProviderCheck(db: Database, table: string): void {
  const row = db.query(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table) as { sql: string } | null;
  if (!row) return;
  const legacy = row.sql.includes("CHECK (provider IN ('claude', 'codex'))")
    ? "CHECK (provider IN ('claude', 'codex'))"
    : row.sql.includes("CHECK (provider IN ('claude', 'codex', 'grok'))")
      ? "CHECK (provider IN ('claude', 'codex', 'grok'))"
      : null;
  if (!legacy) return;
  const target = table === "skills"
    ? "CHECK (provider IN ('claude', 'codex', 'grok'))"
    : "CHECK (provider IN ('claude', 'codex', 'grok', 'reasonix'))";
  if (legacy === target) return;
  rebuildTable(db, table, row.sql.replace(legacy, target));
}

const STAGING_REFERENCE = /"?(\w+?)__(?:grok_provider|provider_migration)"?(?=\s*\()/g;

/**
 * Des reconstructions passées renommaient la table d'origine avant de la
 * recréer : SQLite a réécrit les clés étrangères des autres tables vers ce
 * nom temporaire, supprimé ensuite. Toute écriture qui vérifie ces clés
 * échoue alors avec « no such table ».
 */
function repairStagingForeignKeys(db: Database): void {
  const tables = db.query(
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql LIKE '%REFERENCES%'",
  ).all() as Array<{ name: string; sql: string }>;
  for (const table of tables) {
    const repaired = table.sql.replace(STAGING_REFERENCE, '"$1"');
    if (repaired !== table.sql) rebuildTable(db, table.name, repaired);
  }
}

/**
 * Remplace le schéma d'une table en gardant ses lignes, index et triggers.
 * La table d'origine n'est jamais renommée : SQLite réécrirait vers le nouveau
 * nom les clés étrangères qui la désignent dans les autres tables.
 */
function rebuildTable(db: Database, table: string, createSql: string): void {
  const staging = `${table}__rebuild`;
  const dependents = db.query(
    "SELECT sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL",
  ).all(table) as Array<{ sql: string }>;
  db.exec(`DROP TABLE IF EXISTS "${staging}"`);
  db.exec(createSql.replace(/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:"[^"]+"|\w+)/i, `CREATE TABLE "${staging}"`));
  db.exec(`INSERT INTO "${staging}" SELECT * FROM "${table}"`);
  db.exec(`DROP TABLE "${table}"`);
  db.exec(`ALTER TABLE "${staging}" RENAME TO "${table}"`);
  for (const dependent of dependents) db.exec(dependent.sql);
}

function hasColumn(db: Database, table: string, column: string): boolean {
  const columns = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((item) => item.name === column);
}

function dropColumn(db: Database, table: string, column: string): void {
  if (hasColumn(db, table, column)) {
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

  new SettingsStore(db).set(MESSAGE_COUNT_MIGRATION_KEY, true);
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

/**
 * Les réglages de projet pointaient vers des presets partagés. Chaque usage
 * reçoit une copie de son preset, puis les presets intégrés reprennent les
 * valeurs du code.
 */
function migrateProjectLaunchConfigs(db: Database): void {
  const presetOf = db.query("SELECT provider, model, effort, speed FROM presets WHERE id = ?");
  const projects = db.query(
    "SELECT id, default_preset_id, default_scout_preset_id, default_todo_preset_id FROM projects",
  ).all() as Array<Record<string, string | null>>;
  const slots = [
    ["default_preset_id", "default_launch_config"],
    ["default_scout_preset_id", "scout_launch_config"],
    ["default_todo_preset_id", "todo_launch_config"],
  ] as const;
  db.transaction(() => {
    for (const project of projects) {
      for (const [presetColumn, configColumn] of slots) {
        const presetId = project[presetColumn];
        const preset = presetId ? presetOf.get(presetId) as Record<string, string | null> | null : null;
        if (!preset || !preset.effort) continue;
        const config = { provider: preset.provider, model: preset.model, effort: preset.effort, speed: preset.speed === "fast" ? "fast" : "standard" };
        db.query(`UPDATE projects SET ${configColumn} = ? WHERE id = ?`).run(JSON.stringify(config), project.id!);
      }
    }
    db.exec("UPDATE projects SET default_preset_id = NULL, default_scout_preset_id = NULL, default_todo_preset_id = NULL");
    const reset = db.query("UPDATE presets SET name = ?, provider = ?, model = ?, effort = ?, speed = ? WHERE id = ?");
    for (const preset of BUILT_INS) reset.run(preset.name, preset.provider, preset.model, preset.effort, preset.speed, preset.id);
  })();
}

function migrateTrunkTickets(db: Database): void {
  const trunkIds = (db.query("SELECT id, key FROM tickets WHERE source = 'git'").all() as Array<{ id: string; key: string }>)
    .filter((ticket) => ticket.key === "origin" || isBaseBranch(ticket.key.replace(/^(origin|upstream)\//u, "")))
    .map((ticket) => ticket.id);
  const references = db.query(`
    SELECT m.name AS tableName, f."from" AS columnName, f.on_delete AS onDelete
    FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f
    WHERE m.type = 'table' AND f."table" = 'tickets'
  `).all() as Array<{ tableName: string; columnName: string; onDelete: string }>;
  db.transaction(() => {
    for (const id of trunkIds) {
      for (const reference of references) {
        const statement = reference.onDelete === "SET NULL"
          ? `UPDATE ${reference.tableName} SET ${reference.columnName} = NULL WHERE ${reference.columnName} = ?`
          : `DELETE FROM ${reference.tableName} WHERE ${reference.columnName} = ?`;
        db.query(statement).run(id);
      }
      db.query("DELETE FROM tickets WHERE id = ?").run(id);
    }
    new SettingsStore(db).set(TRUNK_TICKETS_MIGRATION_KEY, true);
  })();
}

function migrateSol61(db: Database): void {
  const settings = new SettingsStore(db);
  const replaceConfig = (value: string | null): string | null => {
    if (value === null) return null;
    try {
      const config = JSON.parse(value) as Record<string, unknown>;
      if (config?.provider === "codex" && config.model === "gpt-6-sol") {
        return JSON.stringify({ ...config, model: "gpt-6.1-sol", effort: "high" });
      }
    } catch {
      return value;
    }
    return value;
  };
  db.transaction(() => {
    for (const table of ["presets", "workflows", "routines", "conversations", "subtasks"]) {
      db.query(`UPDATE ${table} SET model = 'gpt-6.1-sol', effort = 'high' WHERE provider = 'codex' AND model = 'gpt-6-sol'`).run();
    }
    const projects = db.query("SELECT id, default_launch_config, scout_launch_config, todo_launch_config FROM projects")
      .all() as Array<Record<string, string | null>>;
    const update = db.query("UPDATE projects SET default_launch_config = ?, scout_launch_config = ?, todo_launch_config = ? WHERE id = ?");
    for (const project of projects) {
      const columns = ["default_launch_config", "scout_launch_config", "todo_launch_config"] as const;
      const configs = columns.map((column) => replaceConfig(project[column]));
      if (columns.some((column, index) => configs[index] !== project[column])) {
        update.run(...configs, project.id);
      }
    }
    const audit = settings.get<Record<string, unknown>>("ticketAuditConfig");
    if (audit?.provider === "codex" && audit.model === "gpt-6-sol") {
      settings.set("ticketAuditConfig", { ...audit, model: "gpt-6.1-sol", effort: "high" });
    }
    settings.set(SOL_61_MIGRATION_KEY, true);
  })();
}
