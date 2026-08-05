import type { Database } from "bun:sqlite";
import type { Provider } from "../events";

export interface WorkflowInput {
  projectId: string;
  name: string;
  skillId: string | null;
  skillName: string;
  skillInvocation: string;
  prompt: string;
  presetId: string | null;
  provider: Provider;
  model: string;
  effort: string | null;
  speed: "standard" | "fast" | null;
  orchestrator: boolean;
}

export interface Workflow {
  id: string;
  project_id: string;
  name: string;
  skill_id: string | null;
  skill_name: string;
  skill_invocation: string;
  prompt: string;
  preset_id: string | null;
  provider: Provider;
  model: string;
  effort: string | null;
  speed: "standard" | "fast" | null;
  orchestrator: boolean;
  created_at: string;
  updated_at: string;
}

export class WorkflowStore {
  constructor(private readonly db: Database) {}

  get(id: string): Workflow | null {
    const row = this.db.query("SELECT * FROM workflows WHERE id = ?").get(id) as Record<string, unknown> | null;
    return row ? this.hydrate(row) : null;
  }

  listByProject(projectId: string): Workflow[] {
    return (this.db.query(`
      SELECT * FROM workflows
      WHERE project_id = ?
      ORDER BY created_at, name COLLATE NOCASE
    `).all(projectId) as Array<Record<string, unknown>>).map((row) => this.hydrate(row));
  }

  create(input: WorkflowInput): Workflow {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.query(`
      INSERT INTO workflows (
        id, project_id, name, skill_id, skill_name, skill_invocation, prompt,
        preset_id, provider, model, effort, speed, orchestrator, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.projectId, input.name, input.skillId, input.skillName,
      input.skillInvocation, input.prompt, input.presetId, input.provider,
      input.model, input.effort, input.speed, input.orchestrator ? 1 : 0, now, now,
    );
    return this.get(id)!;
  }

  update(id: string, input: WorkflowInput): Workflow | null {
    const result = this.db.query(`
      UPDATE workflows
      SET name = ?, skill_id = ?, skill_name = ?, skill_invocation = ?,
        prompt = ?, preset_id = ?, provider = ?, model = ?, effort = ?, speed = ?,
        orchestrator = ?, updated_at = ?
      WHERE id = ? AND project_id = ?
    `).run(
      input.name, input.skillId, input.skillName, input.skillInvocation,
      input.prompt, input.presetId, input.provider, input.model, input.effort,
      input.speed, input.orchestrator ? 1 : 0, new Date().toISOString(), id,
      input.projectId,
    );
    return result.changes === 1 ? this.get(id) : null;
  }

  delete(id: string): boolean {
    return this.db.query("DELETE FROM workflows WHERE id = ?").run(id).changes === 1;
  }

  private hydrate(row: Record<string, unknown>): Workflow {
    return { ...row, orchestrator: row.orchestrator === 1 } as Workflow;
  }
}
