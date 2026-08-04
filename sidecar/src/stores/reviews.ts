import type { Database } from "bun:sqlite";
import type { Provider } from "../events";

export type ReviewStatus = "running" | "done" | "error";
export type ReviewSeverity = "red" | "orange" | "grey";
export type ReviewFlagStatus = "open" | "acked" | "dismissed" | "countered";

export interface ReviewFlagInput {
  file: string;
  line_start: number;
  line_end: number;
  severity: ReviewSeverity;
  category: string;
  message: string;
}

export interface ReviewFlag extends ReviewFlagInput {
  id: string;
  review_id: string;
  status: ReviewFlagStatus;
}

export interface Review {
  id: string;
  project_id: string;
  conversation_id: string;
  git_ref_base: string;
  git_ref_head: string;
  status: ReviewStatus;
  review_provider: Provider;
  review_model: string;
  review_effort: string;
  diff_text: string;
  error: string | null;
  created_at: string;
  updated_at: string;
  flags: ReviewFlag[];
}

export class ReviewStore {
  constructor(private db: Database) {
    // Un scan `running` ne peut pas survivre au process qui l'exécutait.
    this.db.query(`
      UPDATE reviews
      SET status = 'error', error = 'interrompu (sidecar redémarré)', updated_at = ?
      WHERE status = 'running'
    `).run(new Date().toISOString());
  }

  create(input: {
    projectId: string;
    conversationId: string;
    gitRefBase: string;
    gitRefHead: string;
    provider: Provider;
    model: string;
    effort: string;
  }): Review {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.query(`
      INSERT INTO reviews
        (id, project_id, conversation_id, git_ref_base, git_ref_head, status,
         review_provider, review_model, review_effort, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)
    `).run(
      id,
      input.projectId,
      input.conversationId,
      input.gitRefBase,
      input.gitRefHead,
      input.provider,
      input.model,
      input.effort,
      now,
      now,
    );
    return this.get(id)!;
  }

  get(id: string): Review | null {
    const row = this.db.query("SELECT * FROM reviews WHERE id = ?").get(id) as any;
    return row ? this.hydrate(row) : null;
  }

  listByProject(projectId: string): Review[] {
    const rows = this.db.query(`
      SELECT * FROM reviews WHERE project_id = ? ORDER BY created_at DESC
    `).all(projectId) as any[];
    return rows.map((row) => this.hydrate(row));
  }

  setFlagStatus(id: string, status: Exclude<ReviewFlagStatus, "countered">): ReviewFlag | null {
    this.db.query("UPDATE review_flags SET status = ? WHERE id = ?").run(status, id);
    return this.getFlag(id);
  }

  getFlag(id: string): ReviewFlag | null {
    return this.db.query("SELECT * FROM review_flags WHERE id = ?").get(id) as ReviewFlag | null;
  }

  gardienStatus(projectId: string, mode: "informatif" | "bloquant"): {
    mode: "informatif" | "bloquant";
    blocked: boolean;
    openRedCount: number;
  } {
    const row = this.db.query(`
      SELECT COUNT(*) AS count
      FROM review_flags f
      JOIN reviews r ON r.id = f.review_id
      WHERE r.project_id = ? AND f.severity = 'red' AND f.status = 'open'
    `).get(projectId) as { count: number | bigint };
    const openRedCount = Number(row.count);
    return { mode, blocked: mode === "bloquant" && openRedCount > 0, openRedCount };
  }

  setDiff(id: string, base: string, head: string, diff: string): void {
    this.db.query(`
      UPDATE reviews
      SET git_ref_base = ?, git_ref_head = ?, diff_text = ?, updated_at = ?
      WHERE id = ?
    `).run(base, head, diff, new Date().toISOString(), id);
  }

  complete(id: string, flags: ReviewFlagInput[]): void {
    const complete = this.db.transaction(() => {
      const insert = this.db.query(`
        INSERT INTO review_flags
          (id, review_id, file, line_start, line_end, severity, category, message, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open')
      `);
      for (const flag of flags) {
        insert.run(
          crypto.randomUUID(),
          id,
          flag.file,
          flag.line_start,
          flag.line_end,
          flag.severity,
          flag.category,
          flag.message,
        );
      }
      this.db.query(`
        UPDATE reviews SET status = 'done', error = NULL, updated_at = ? WHERE id = ?
      `).run(new Date().toISOString(), id);
    });
    complete();
  }

  fail(id: string, error: string): void {
    this.db.query(`
      UPDATE reviews SET status = 'error', error = ?, updated_at = ? WHERE id = ?
    `).run(error, new Date().toISOString(), id);
  }

  private hydrate(row: any): Review {
    const flags = this.db.query(`
      SELECT * FROM review_flags
      WHERE review_id = ?
      ORDER BY CASE severity WHEN 'red' THEN 0 WHEN 'orange' THEN 1 ELSE 2 END,
               file ASC, line_start ASC
    `).all(row.id) as ReviewFlag[];
    return { ...row, flags } as Review;
  }
}
