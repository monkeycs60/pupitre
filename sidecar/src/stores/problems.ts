import type { Database } from "bun:sqlite";
import { problemIdsInCommit } from "../problem-id";

export type ProblemCaptureStatus = "queued" | "processing" | "done" | "error";
export type ProblemStatus = "open" | "closed";
export type ProblemListStatus = ProblemStatus | "all";

export interface ProblemPlan {
  title: string;
  instruction: string;
}

export interface ProblemCapture {
  id: string;
  project_id: string;
  raw_text: string;
  status: ProblemCaptureStatus;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface Problem {
  id: string;
  public_id: string;
  capture_id: string;
  project_id: string;
  ticket_id: string | null;
  title: string;
  context: string;
  resolution: string;
  plans: ProblemPlan[];
  status: ProblemStatus;
  closed_at: string | null;
  closed_commit_sha: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProblemDraft {
  publicId: string;
  ticketId: string | null;
  title: string;
  context: string;
  resolution: string;
  plans: ProblemPlan[];
}

export interface ProblemProjectPayload {
  projectId: string;
  captures: ProblemCapture[];
  problems: Problem[];
}

export class ProblemStore {
  constructor(private db: Database) {}

  createCapture(projectId: string, rawText: string): ProblemCapture {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.query(`
      INSERT INTO problem_captures
        (id, project_id, raw_text, status, error, created_at, updated_at)
      VALUES (?, ?, ?, 'queued', NULL, ?, ?)
    `).run(id, projectId, rawText, now, now);
    return this.getCapture(id)!;
  }

  getCapture(id: string): ProblemCapture | null {
    const row = this.db.query(
      "SELECT * FROM problem_captures WHERE id = ?",
    ).get(id) as Record<string, unknown> | null;
    return row ? hydrateCapture(row) : null;
  }

  queuedCaptures(): ProblemCapture[] {
    return (this.db.query(`
      SELECT * FROM problem_captures
      WHERE status = 'queued'
      ORDER BY created_at, id
    `).all() as Record<string, unknown>[]).map(hydrateCapture);
  }

  recoverCaptures(): ProblemCapture[] {
    this.db.query(`
      UPDATE problem_captures
      SET status = 'queued', error = NULL, updated_at = ?
      WHERE status = 'processing'
    `).run(new Date().toISOString());
    return this.queuedCaptures();
  }

  markProcessing(id: string): ProblemCapture | null {
    const result = this.db.query(`
      UPDATE problem_captures
      SET status = 'processing', error = NULL, updated_at = ?
      WHERE id = ? AND status = 'queued'
    `).run(new Date().toISOString(), id);
    return result.changes > 0 ? this.getCapture(id) : null;
  }

  queueAgain(id: string): ProblemCapture | null {
    this.db.query(`
      UPDATE problem_captures
      SET status = 'queued', error = NULL, updated_at = ?
      WHERE id = ? AND status = 'error'
    `).run(new Date().toISOString(), id);
    return this.getCapture(id);
  }

  markError(id: string, error: string): ProblemCapture | null {
    this.db.query(`
      UPDATE problem_captures
      SET status = 'error', error = ?, updated_at = ?
      WHERE id = ? AND status != 'done'
    `).run(error, new Date().toISOString(), id);
    return this.getCapture(id);
  }

  completeCapture(captureId: string, drafts: ProblemDraft[]): Problem[] {
    const write = this.db.transaction(() => {
      const capture = this.getCapture(captureId);
      if (!capture) throw new Error("capture inconnue");
      if (capture.status === "done") return this.problemsForCapture(captureId);
      const now = new Date().toISOString();
      const insert = this.db.query(`
        INSERT INTO problems (
          id, public_id, capture_id, project_id, ticket_id, title, context,
          resolution, plans_json, status, closed_at, closed_commit_sha,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, NULL, ?, ?)
      `);
      for (const draft of drafts) {
        insert.run(
          crypto.randomUUID(),
          draft.publicId,
          captureId,
          capture.project_id,
          draft.ticketId,
          draft.title,
          draft.context,
          draft.resolution,
          JSON.stringify(draft.plans),
          now,
          now,
        );
      }
      this.db.query(`
        UPDATE problem_captures
        SET status = 'done', error = NULL, updated_at = ?
        WHERE id = ?
      `).run(now, captureId);
      return this.problemsForCapture(captureId);
    });
    return write();
  }

  get(id: string): Problem | null {
    const row = this.db.query(
      "SELECT * FROM problems WHERE id = ?",
    ).get(id) as Record<string, unknown> | null;
    return row ? hydrateProblem(row) : null;
  }

  getByPublicId(publicId: string): Problem | null {
    const row = this.db.query(
      "SELECT * FROM problems WHERE public_id = ?",
    ).get(publicId) as Record<string, unknown> | null;
    return row ? hydrateProblem(row) : null;
  }

  listProject(projectId: string, status: ProblemListStatus = "open"): ProblemProjectPayload {
    const rows = this.db.query(`
      SELECT * FROM problems
      WHERE project_id = ? ${status === "all" ? "" : "AND status = ?"}
      ORDER BY created_at DESC, id DESC
    `).all(...(status === "all" ? [projectId] : [projectId, status])) as Record<string, unknown>[];
    const captures = (this.db.query(`
      SELECT * FROM problem_captures
      WHERE project_id = ? AND status IN ('queued', 'processing', 'error')
      ORDER BY created_at DESC, id DESC
    `).all(projectId) as Record<string, unknown>[]).map(hydrateCapture);
    return { projectId, captures, problems: rows.map(hydrateProblem) };
  }

  setTicket(id: string, ticketId: string | null): Problem | null {
    const problem = this.get(id);
    if (!problem) return null;
    if (ticketId !== null) {
      const ticket = this.db.query(
        "SELECT project_id FROM tickets WHERE id = ?",
      ).get(ticketId) as { project_id: string } | null;
      if (!ticket) throw new Error("ticket inconnu");
      if (ticket.project_id !== problem.project_id) throw new Error("ticket d'un autre projet");
    }
    this.db.query(
      "UPDATE problems SET ticket_id = ?, updated_at = ? WHERE id = ?",
    ).run(ticketId, new Date().toISOString(), id);
    return this.get(id);
  }

  close(id: string, commitSha: string | null = null): Problem | null {
    const now = new Date().toISOString();
    this.db.query(`
      UPDATE problems
      SET status = 'closed', closed_at = ?, closed_commit_sha = ?, updated_at = ?
      WHERE id = ? AND status = 'open'
    `).run(now, commitSha, now, id);
    return this.get(id);
  }

  reopen(id: string): Problem | null {
    this.db.query(`
      UPDATE problems
      SET status = 'open', closed_at = NULL, closed_commit_sha = NULL, updated_at = ?
      WHERE id = ? AND status = 'closed'
    `).run(new Date().toISOString(), id);
    return this.get(id);
  }

  closeFromCommit(projectId: string, message: string, commitSha: string): number {
    const ids = problemIdsInCommit(message);
    if (ids.length === 0) return 0;
    const close = this.db.query(`
      UPDATE problems
      SET status = 'closed', closed_at = ?, closed_commit_sha = ?, updated_at = ?
      WHERE project_id = ? AND public_id = ? AND status = 'open'
    `);
    const now = new Date().toISOString();
    return this.db.transaction(() => {
      let closed = 0;
      for (const publicId of ids) {
        closed += close.run(now, commitSha, now, projectId, publicId).changes;
      }
      return closed;
    })();
  }

  delete(id: string): boolean {
    return this.db.query("DELETE FROM problems WHERE id = ?").run(id).changes > 0;
  }

  private problemsForCapture(captureId: string): Problem[] {
    return (this.db.query(`
      SELECT * FROM problems WHERE capture_id = ? ORDER BY created_at, id
    `).all(captureId) as Record<string, unknown>[]).map(hydrateProblem);
  }
}

function hydrateCapture(row: Record<string, unknown>): ProblemCapture {
  return {
    id: String(row.id),
    project_id: String(row.project_id),
    raw_text: String(row.raw_text),
    status: row.status as ProblemCaptureStatus,
    error: row.error === null ? null : String(row.error),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function hydrateProblem(row: Record<string, unknown>): Problem {
  return {
    id: String(row.id),
    public_id: String(row.public_id),
    capture_id: String(row.capture_id),
    project_id: String(row.project_id),
    ticket_id: row.ticket_id === null ? null : String(row.ticket_id),
    title: String(row.title),
    context: String(row.context),
    resolution: String(row.resolution),
    plans: JSON.parse(String(row.plans_json)) as ProblemPlan[],
    status: row.status as ProblemStatus,
    closed_at: row.closed_at === null ? null : String(row.closed_at),
    closed_commit_sha: row.closed_commit_sha === null ? null : String(row.closed_commit_sha),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}
