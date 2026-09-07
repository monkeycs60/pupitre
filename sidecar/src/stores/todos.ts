import type { Database } from "bun:sqlite";
import type { MediaAttachment, Provider } from "../events";
import type { PresetPermissionMode } from "./presets";
export type TodoStatus =
  "queued" | "running" | "awaiting_validation" | "done" | "blocked";
export interface TodoInput {
  title?: string;
  message: string;
  targetBranch?: string | null;
  ticketId?: string | null;
  integrate?: boolean;
  autonomy?: "local" | "investigate";
  dependsOn?: string | null;
  provider: Provider;
  model: string;
  effort?: string | null;
  speed?: "standard" | "fast" | null;
  presetId?: string | null;
  permissionMode?: PresetPermissionMode | null;
  orchestrator?: boolean;
  subagentPresetId?: string | null;
  subagentEffort?: string | null;
  images?: string[];
  attachments?: MediaAttachment[];
  checks?: string[];
}
export interface TodoItem {
  id: string;
  project_id: string;
  title: string;
  message: string;
  ticket_id: string | null;
  target_branch: string;
  integrate: boolean;
  autonomy: "local" | "investigate";
  depends_on: string | null;
  status: TodoStatus;
  execution_completed: boolean;
  publication_pending: boolean;
  conversation_id: string | null;
  branch: string | null;
  worktree_path: string | null;
  error: string | null;
  position: number;
  created_at: string;
  updated_at: string;
  provider: Provider;
  model: string;
  effort: string | null;
  speed: "standard" | "fast" | null;
  preset_id: string | null;
  permission_mode: PresetPermissionMode | null;
  orchestrator: boolean;
  subagent_preset_id: string | null;
  subagent_effort: string | null;
  images: string[];
  attachments: MediaAttachment[];
  checks: string[];
}
export class TodoStore {
  constructor(private db: Database) {
    db.run(
      "CREATE TABLE IF NOT EXISTS project_todos (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, payload TEXT NOT NULL)",
    );
    db.run(
      "CREATE INDEX IF NOT EXISTS project_todos_project ON project_todos(project_id)",
    );
    for (const item of this.list())
      if (item.status === "running")
        this.update(item.id, {
          status: "blocked",
          error:
            "Interrompu par le redémarrage du sidecar ; vérifier le worktree avant toute reprise.",
        });
  }
  list(projectId?: string): TodoItem[] {
    const rows = (
      projectId
        ? this.db
            .query("SELECT payload FROM project_todos WHERE project_id=?")
            .all(projectId)
        : this.db.query("SELECT payload FROM project_todos").all()
    ) as { payload: string }[];
    return rows
      .map((r) => JSON.parse(r.payload) as TodoItem)
      .sort(
        (a, b) =>
          a.position - b.position || a.created_at.localeCompare(b.created_at),
      );
  }
  get(id: string): TodoItem | null {
    const row = this.db
      .query("SELECT payload FROM project_todos WHERE id=?")
      .get(id) as { payload: string } | null;
    return row ? JSON.parse(row.payload) : null;
  }
  create(projectId: string, input: TodoInput): TodoItem {
    const now = new Date().toISOString();
    const item: TodoItem = {
      id: crypto.randomUUID(),
      project_id: projectId,
      title: input.title?.trim() || input.message.slice(0, 80),
      message: input.message,
      ticket_id: input.ticketId ?? null,
      target_branch: input.targetBranch!,
      integrate: input.integrate ?? false,
      autonomy: input.autonomy ?? "local",
      depends_on: input.dependsOn ?? null,
      status: "queued",
      execution_completed: false,
      publication_pending: false,
      conversation_id: null,
      branch: null,
      worktree_path: null,
      error: null,
      position:
        Math.max(-1, ...this.list(projectId).map((t) => t.position)) + 1,
      created_at: now,
      updated_at: now,
      provider: input.provider,
      model: input.model,
      effort: input.effort ?? null,
      speed: input.speed ?? null,
      preset_id: input.presetId ?? null,
      permission_mode: input.permissionMode ?? null,
      orchestrator: input.orchestrator ?? true,
      subagent_preset_id: input.subagentPresetId ?? null,
      subagent_effort: input.subagentEffort ?? null,
      images: input.images ?? [],
      attachments: input.attachments ?? [],
      checks: input.checks ?? [],
    };
    this.db
      .query("INSERT INTO project_todos VALUES (?,?,?)")
      .run(item.id, projectId, JSON.stringify(item));
    return item;
  }
  update(id: string, patch: Partial<TodoItem>): TodoItem {
    const item = this.get(id);
    if (!item) throw new Error("TODO inconnu");
    const next = {
      ...item,
      ...patch,
      id,
      project_id: item.project_id,
      updated_at: new Date().toISOString(),
    };
    this.db
      .query("UPDATE project_todos SET payload=? WHERE id=?")
      .run(JSON.stringify(next), id);
    return next;
  }
  delete(id: string): void {
    this.db.query("DELETE FROM project_todos WHERE id=?").run(id);
  }
  reorder(projectId: string, ids: string[]): void {
    const items = this.list(projectId).filter((t) => t.status === "queued");
    if (
      ids.length !== items.length ||
      new Set(ids).size !== ids.length ||
      items.some((t) => !ids.includes(t.id))
    )
      throw new Error(
        "La liste doit contenir chaque TODO en attente une seule fois",
      );
    this.db.transaction(() =>
      ids.forEach((id, i) => this.update(id, { position: i })),
    )();
  }
}
