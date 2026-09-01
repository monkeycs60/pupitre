import type { Database } from "bun:sqlite";

export type AttentionSeverity = "info" | "warning" | "error";
export type AttentionTarget =
  | { kind: "conversation"; projectId: string; conversationId: string }
  | { kind: "problem-axis"; projectId: string; problemId: string; planIndex: number };

export interface AttentionItem {
  id: string;
  type: string;
  project_id: string;
  source_key: string;
  severity: AttentionSeverity;
  title: string;
  body: string;
  target: AttentionTarget;
  condition_version: string;
  created_at: string;
  updated_at: string;
}

type AttentionRow = Omit<AttentionItem, "target"> & { target_json: string };

export class AttentionItemStore {
  constructor(private readonly db: Database) {}

  synchronizeProblemAxes(): void {
    const now = new Date().toISOString();
    const actionable = this.db.query(`
      SELECT runs.*, problems.project_id, problems.public_id, problems.title AS problem_title,
             json_extract(problems.plans_json, '$[' || runs.plan_index || '].title') AS axis_title
      FROM problem_axis_runs runs
      JOIN problems ON problems.id = runs.problem_id
      JOIN (
        SELECT problem_id, plan_index, MAX(created_at) AS latest
        FROM problem_axis_runs GROUP BY problem_id, plan_index
      ) selected ON selected.problem_id = runs.problem_id
        AND selected.plan_index = runs.plan_index AND selected.latest = runs.created_at
      WHERE runs.status IN ('interrupted', 'failed', 'awaiting_validation')
    `).all() as Array<Record<string, unknown>>;
    const liveKeys = new Set(actionable.map((row) => `axis:${row.id}`));
    const existing = this.db.query(
      "SELECT source_key FROM attention_items WHERE type = 'problem-axis' AND resolved_at IS NULL",
    ).all() as Array<{ source_key: string }>;
    const resolve = this.db.query(
      "UPDATE attention_items SET resolved_at = ?, updated_at = ? WHERE type = 'problem-axis' AND source_key = ?",
    );
    for (const row of existing) if (!liveKeys.has(row.source_key)) resolve.run(now, now, row.source_key);

    for (const row of actionable) {
      const status = String(row.status);
      const label = status === "awaiting_validation" ? "À valider" : status === "failed" ? "En échec" : "Interrompu";
      const severity: AttentionSeverity = status === "failed" ? "error" : "warning";
      this.upsert({
        type: "problem-axis",
        projectId: String(row.project_id),
        sourceKey: `axis:${row.id}`,
        severity,
        title: `${label} · ${String(row.public_id)} · ${String(row.axis_title ?? `Axe ${Number(row.plan_index) + 1}`)}`,
        body: String(row.error ?? row.problem_title),
        target: row.conversation_id
          ? { kind: "conversation", projectId: String(row.project_id), conversationId: String(row.conversation_id) }
          : { kind: "problem-axis", projectId: String(row.project_id), problemId: String(row.problem_id), planIndex: Number(row.plan_index) },
        conditionVersion: `${status}:${String(row.updated_at)}`,
      });
    }
  }

  upsert(input: {
    type: string;
    projectId: string;
    sourceKey: string;
    severity: AttentionSeverity;
    title: string;
    body: string;
    target: AttentionTarget;
    conditionVersion: string;
  }): AttentionItem {
    const now = new Date().toISOString();
    const existing = this.db.query(
      "SELECT id FROM attention_items WHERE type = ? AND source_key = ?",
    ).get(input.type, input.sourceKey) as { id: string } | null;
    const id = existing?.id ?? crypto.randomUUID();
    this.db.query(`
      INSERT INTO attention_items
        (id, type, project_id, source_key, severity, title, body, target_json,
         condition_version, acknowledged_version, resolved_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
      ON CONFLICT(type, source_key) DO UPDATE SET
        severity = excluded.severity, title = excluded.title, body = excluded.body,
        target_json = excluded.target_json, condition_version = excluded.condition_version,
        resolved_at = NULL, updated_at = excluded.updated_at
    `).run(id, input.type, input.projectId, input.sourceKey, input.severity, input.title, input.body,
      JSON.stringify(input.target), input.conditionVersion, now, now);
    return this.get(id)!;
  }

  get(id: string): AttentionItem | null {
    const row = this.db.query("SELECT * FROM attention_items WHERE id = ?").get(id) as AttentionRow | null;
    return row ? hydrate(row) : null;
  }

  list(projectId?: string | null): AttentionItem[] {
    const predicate = projectId ? "AND project_id = ?" : "";
    const rows = this.db.query(`
      SELECT * FROM attention_items
      WHERE resolved_at IS NULL
        AND (acknowledged_version IS NULL OR acknowledged_version != condition_version)
        ${predicate}
      ORDER BY CASE severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, updated_at DESC
    `).all(...(projectId ? [projectId] : [])) as AttentionRow[];
    return rows.map(hydrate);
  }

  acknowledge(id: string): AttentionItem | null {
    this.db.query(`
      UPDATE attention_items SET acknowledged_version = condition_version, updated_at = ? WHERE id = ?
    `).run(new Date().toISOString(), id);
    return this.get(id);
  }
}

function hydrate(row: AttentionRow): AttentionItem {
  const { target_json, ...rest } = row;
  return { ...rest, target: JSON.parse(target_json) as AttentionTarget };
}
