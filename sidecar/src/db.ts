import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { countConversationMessages } from "./message-count";
import {
  MESSAGE_COUNT_MIGRATION_KEY,
  QUALITY_FABLE_51_MIGRATION_KEY,
  SettingsStore,
  SPEED_REVIEW_MIGRATION_KEY,
} from "./stores/settings";
import { defaultDataDir, readInstance } from "./instance";

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
      source TEXT NOT NULL CHECK (source IN ('clickup', 'notion', 'git')),
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
    CREATE TABLE IF NOT EXISTS domains (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL COLLATE NOCASE,
      kind TEXT NOT NULL CHECK (kind IN ('métier', 'technique')),
      status TEXT NOT NULL CHECK (status IN ('actif', 'proposé')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (project_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_domains_project ON domains(project_id, status, name);
    CREATE TABLE IF NOT EXISTS conversation_domains (
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      domain_id TEXT NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
      origin TEXT NOT NULL CHECK (origin IN ('auto', 'manuel')),
      created_at TEXT NOT NULL,
      PRIMARY KEY (conversation_id, domain_id)
    );
    CREATE INDEX IF NOT EXISTS idx_conversation_domains_domain ON conversation_domains(domain_id);
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
    CREATE TABLE IF NOT EXISTS domain_changes (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      review_id TEXT NOT NULL REFERENCES changelog_reviews(id) ON DELETE CASCADE,
      domain_id TEXT NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
      nature TEXT NOT NULL CHECK (nature IN ('ajout', 'modification', 'correction', 'retrait')),
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      impact TEXT NOT NULL,
      evidence_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      UNIQUE (group_id, domain_id)
    );
    CREATE INDEX IF NOT EXISTS idx_domain_changes_domain
      ON domain_changes(domain_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS domain_publications (
      domain_id TEXT PRIMARY KEY REFERENCES domains(id) ON DELETE CASCADE,
      skill_root TEXT NOT NULL,
      skill_sha256 TEXT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS project_changelog_entries (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      repository_path TEXT NOT NULL DEFAULT '.',
      commit_sha TEXT NOT NULL,
      branch TEXT NOT NULL,
      subject TEXT NOT NULL,
      committed_at TEXT NOT NULL,
      domain_id TEXT NULL REFERENCES domains(id) ON DELETE SET NULL,
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
  addColumn(db, "projects", "mcp_servers TEXT NULL");
  addColumn(db, "conversations", "title_locked INTEGER NOT NULL DEFAULT 0");
  // Nombre de tours au moment du dernier digest (0 = jamais généré).
  addColumn(db, "conversations", "digest_turn INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "conversations", "ticket_id TEXT NULL REFERENCES tickets(id) ON DELETE SET NULL");
  addColumn(db, "project_changelog_entries", "lines_added INTEGER NULL");
  addColumn(db, "project_changelog_entries", "lines_removed INTEGER NULL");
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
  db.exec("DROP TABLE IF EXISTS review_decisions");
  widenProviderCheck(db, "skills");
  widenProviderCheck(db, "workflows");
  widenProviderCheck(db, "routines");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_skills_provider_project
      ON skills(provider, project_id, name COLLATE NOCASE);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflows_project_name
      ON workflows(project_id, name COLLATE NOCASE);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_routines_project_name
      ON routines(project_id, name COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_routines_due
      ON routines(enabled, next_run_at);
    DELETE FROM conversation_domains
      WHERE domain_id IN (SELECT id FROM domains WHERE status = 'proposé');
    DELETE FROM domains WHERE status = 'proposé';
  `);
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
      domain_id TEXT NULL REFERENCES domains(id) ON DELETE SET NULL,
      product_message TEXT NULL,
      enrichment_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (enrichment_status IN ('pending', 'enriched')),
      imported_at TEXT NOT NULL,
      enriched_at TEXT NULL,
      PRIMARY KEY (project_id, commit_sha)
    );
    INSERT OR IGNORE INTO project_changelog_entries_v2
      (project_id, repository_path, commit_sha, branch, subject, committed_at,
       domain_id, product_message, enrichment_status, imported_at, enriched_at)
    SELECT project_id, '.', commit_sha, branch, subject, committed_at,
           domain_id, product_message, enrichment_status, imported_at, enriched_at
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
  const rebuilt = row.sql.replace(legacy, target);
  const staging = `${table}__provider_migration`;
  db.exec(`ALTER TABLE ${table} RENAME TO ${staging}`);
  db.exec(rebuilt);
  db.exec(`INSERT INTO ${table} SELECT * FROM ${staging}`);
  db.exec(`DROP TABLE ${staging}`);
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
