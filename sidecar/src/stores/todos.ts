import type { Database } from "bun:sqlite";
import type { MediaAttachment, Provider } from "../events";
import type { PresetPermissionMode } from "./presets";
export type TodoStatus =
  "backlog" | "queued" | "running" | "awaiting_validation" | "done" | "blocked";
export type TodoFinish = "none" | "commit" | "commit_push";
export const TODO_FINISHES: TodoFinish[] = ["none", "commit", "commit_push"];
export interface TodoInput {
  status?: "backlog" | "queued";
  title?: string;
  message: string;
  targetBranch?: string | null;
  ticketId?: string | null;
  finish?: TodoFinish;
  provider: Provider;
  model: string;
  effort?: string | null;
  speed?: "standard" | "fast" | null;
  presetId?: string | null;
  permissionMode?: PresetPermissionMode | null;
  images?: string[];
  attachments?: MediaAttachment[];
}
export interface TodoItem {
  id: string;
  project_id: string;
  title: string;
  message: string;
  ticket_id: string | null;
  target_branch: string;
  finish: TodoFinish;
  status: TodoStatus;
  execution_completed: boolean;
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
  images: string[];
  attachments: MediaAttachment[];
}
function titleOf(message: string): string {
  const line = message.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
}
/** Les payloads antérieurs portaient `integrate` : un push automatique. */
function normalize(raw: Record<string, unknown>): TodoItem {
  const { integrate, autonomy: _a, depends_on: _d, checks: _c, publication_pending: _p, ...rest } = raw;
  const finish = TODO_FINISHES.includes(rest.finish as TodoFinish)
    ? rest.finish as TodoFinish
    : integrate === true ? "commit_push" : "none";
  return { ...rest, finish } as TodoItem;
}
export class TodoStore {
  constructor(private db: Database) {
    db.run(
      "CREATE TABLE IF NOT EXISTS project_todos (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, payload TEXT NOT NULL)",
    );
    db.run(
      "CREATE INDEX IF NOT EXISTS project_todos_project ON project_todos(project_id)",
    );
    // Pendant du recalage `default` → `plan` de `migrate()` : la table est créée
    // ici, pas dans les migrations, donc la réécriture y vit aussi.
    db.run(`
      UPDATE project_todos
      SET payload = json_set(payload, '$.permission_mode', 'plan')
      WHERE json_valid(payload)
        AND json_extract(payload, '$.permission_mode') = 'default'
    `);
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
      .map((r) => normalize(JSON.parse(r.payload)))
      .sort(
        (a, b) =>
          a.position - b.position || a.created_at.localeCompare(b.created_at),
      );
  }
  get(id: string): TodoItem | null {
    const row = this.db
      .query("SELECT payload FROM project_todos WHERE id=?")
      .get(id) as { payload: string } | null;
    return row ? normalize(JSON.parse(row.payload)) : null;
  }
  create(projectId: string, input: TodoInput): TodoItem {
    const now = new Date().toISOString();
    const item: TodoItem = {
      id: crypto.randomUUID(),
      project_id: projectId,
      title: input.title?.trim() || titleOf(input.message),
      message: input.message,
      ticket_id: input.ticketId ?? null,
      target_branch: input.targetBranch ?? "",
      finish: input.finish ?? "none",
      status: input.status ?? "queued",
      execution_completed: false,
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
      images: input.images ?? [],
      attachments: input.attachments ?? [],
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
  /** `ids` : toutes les tâches ouvertes du projet, dans l'ordre voulu. Les
   *  tâches terminées gardent leur rang derrière la pile. */
  reorder(projectId: string, ids: string[]): void {
    const items = this.list(projectId).filter((t) => t.status !== "done");
    if (
      ids.length !== items.length ||
      new Set(ids).size !== ids.length ||
      items.some((t) => !ids.includes(t.id))
    )
      throw new Error(
        "La liste doit contenir chaque tâche ouverte une seule fois",
      );
    const done = this.list(projectId).filter((t) => t.status === "done");
    this.db.transaction(() => {
      ids.forEach((id, i) => this.update(id, { position: i }));
      done.forEach((t, i) => this.update(t.id, { position: ids.length + i }));
    })();
  }
}
