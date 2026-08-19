import type { Database } from "bun:sqlite";
import { compileBranchPattern } from "../ticket-key";

export type IntegrationType = "clickup" | "gitlab" | "github" | "notion" | "sentry";
export type IntegrationStatus = "ok" | "dégradée" | "hors ligne" | "non configurée" | "à reconfigurer";

export interface ProjectIntegration {
  id: string;
  project_id: string;
  type: IntegrationType;
  config: Record<string, unknown>;
  branch_pattern: string | null;
  status: IntegrationStatus;
  last_ok_at: string | null;
  last_error: string | null;
  snapshot: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface IntegrationInput {
  config: Record<string, unknown>;
  branchPattern?: string | null;
}

export class IntegrationStore {
  constructor(private db: Database) {}

  get(id: string): ProjectIntegration | null {
    const row = this.db.query("SELECT * FROM project_integrations WHERE id = ?").get(id) as
      | Record<string, unknown>
      | null;
    return row ? hydrate(row) : null;
  }

  find(projectId: string, type: IntegrationType): ProjectIntegration | null {
    const row = this.db.query("SELECT * FROM project_integrations WHERE project_id = ? AND type = ?").get(projectId, type) as
      | Record<string, unknown>
      | null;
    return row ? hydrate(row) : null;
  }

  listByProject(projectId: string): ProjectIntegration[] {
    const rows = this.db.query("SELECT * FROM project_integrations WHERE project_id = ? ORDER BY type").all(projectId) as Record<string, unknown>[];
    return rows.map(hydrate);
  }

  listAll(): ProjectIntegration[] {
    const rows = this.db.query("SELECT * FROM project_integrations ORDER BY project_id, type").all() as Record<string, unknown>[];
    return rows.map(hydrate);
  }

  upsert(projectId: string, type: IntegrationType, input: IntegrationInput): ProjectIntegration {
    if (input.branchPattern !== undefined && input.branchPattern !== null) {
      if (input.branchPattern === "") {
        throw new Error("branchPattern vide");
      }
      compileBranchPattern(input.branchPattern);
    }

    const now = new Date().toISOString();
    const existing = this.find(projectId, type);
    const branchPattern = input.branchPattern ?? existing?.branch_pattern ?? null;

    if (existing) {
      this.db.query(`
        UPDATE project_integrations
           SET config_json = ?, branch_pattern = ?, updated_at = ?
         WHERE id = ?
      `).run(JSON.stringify(input.config), branchPattern, now, existing.id);
      return this.get(existing.id)!;
    }

    const id = crypto.randomUUID();
    this.db.query(`
      INSERT INTO project_integrations (
        id, project_id, type, config_json, branch_pattern, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'non configurée', ?, ?)
    `).run(id, projectId, type, JSON.stringify(input.config), branchPattern, now, now);
    return this.get(id)!;
  }

  markOk(id: string, snapshot?: Record<string, unknown>): void {
    const now = new Date().toISOString();
    this.db.query(`
      UPDATE project_integrations
         SET status = 'ok',
             last_ok_at = ?,
             last_error = NULL,
             snapshot_json = COALESCE(?, snapshot_json),
             updated_at = ?
       WHERE id = ?
    `).run(now, snapshot === undefined ? null : JSON.stringify(snapshot), now, id);
  }

  markUnconfigured(id: string): void {
    this.db.query(`
      UPDATE project_integrations
         SET status = 'non configurée',
             last_error = NULL,
             updated_at = ?
       WHERE id = ?
    `).run(new Date().toISOString(), id);
  }

  markError(id: string, status: Exclude<IntegrationStatus, "ok" | "non configurée">, error: string): void {
    this.db.query(`
      UPDATE project_integrations
         SET status = ?,
             last_error = ?,
             updated_at = ?
       WHERE id = ?
    `).run(status, error, new Date().toISOString(), id);
  }

  remove(id: string): boolean {
    return this.db.query("DELETE FROM project_integrations WHERE id = ?").run(id).changes === 1;
  }
}

function hydrate(row: Record<string, unknown>): ProjectIntegration {
  return {
    id: String(row.id),
    project_id: String(row.project_id),
    type: row.type as IntegrationType,
    config: JSON.parse(String(row.config_json ?? "{}")) as Record<string, unknown>,
    branch_pattern: (row.branch_pattern as string | null | undefined) ?? null,
    status: row.status as IntegrationStatus,
    last_ok_at: (row.last_ok_at as string | null | undefined) ?? null,
    last_error: (row.last_error as string | null | undefined) ?? null,
    snapshot: JSON.parse(String(row.snapshot_json ?? "{}")) as Record<string, unknown>,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}
