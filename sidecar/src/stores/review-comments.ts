import type { Database } from "bun:sqlite";

export type ReviewCommentStatus = "draft" | "sent";

/** Commentaire de relecture posé sur une ou plusieurs lignes d'un diff de la conversation. */
export interface ReviewComment {
  id: string;
  conversation_id: string;
  repository_label: string;
  worktree_path: string;
  path: string;
  side: "new" | "old";
  start_line: number;
  end_line: number;
  line_text: string;
  body: string;
  status: ReviewCommentStatus;
  created_at: string;
  sent_at: string | null;
  /** État du worktree au moment de l'envoi (commit ou stash), référence pour juger si le commentaire a été traité. */
  head_at_send: string | null;
}

export interface ReviewCommentInput {
  repositoryLabel: string;
  worktreePath: string;
  path: string;
  side: "new" | "old";
  startLine: number;
  endLine: number;
  lineText: string;
  body: string;
}

export class ReviewCommentStore {
  constructor(private readonly db: Database) {}

  list(conversationId: string): ReviewComment[] {
    return this.db.query("SELECT * FROM review_comments WHERE conversation_id = ? ORDER BY created_at")
      .all(conversationId) as ReviewComment[];
  }

  get(id: string): ReviewComment | null {
    return this.db.query("SELECT * FROM review_comments WHERE id = ?").get(id) as ReviewComment | null;
  }

  create(conversationId: string, input: ReviewCommentInput): ReviewComment {
    const id = crypto.randomUUID();
    this.db.query(`
      INSERT INTO review_comments
        (id, conversation_id, repository_label, worktree_path, path, side, start_line, end_line, line_text, body, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)
    `).run(
      id, conversationId, input.repositoryLabel, input.worktreePath, input.path, input.side,
      Math.min(input.startLine, input.endLine), Math.max(input.startLine, input.endLine),
      input.lineText, input.body, new Date().toISOString(),
    );
    return this.get(id)!;
  }

  updateBody(id: string, body: string): ReviewComment | null {
    this.db.query("UPDATE review_comments SET body = ? WHERE id = ? AND status = 'draft'").run(body, id);
    return this.get(id);
  }

  delete(id: string): boolean {
    return this.db.query("DELETE FROM review_comments WHERE id = ?").run(id).changes > 0;
  }

  /**
   * Passe les brouillons de la conversation à « envoyé » en retenant, par
   * worktree, l'état donné par `snapshotOf`, et les renvoie dans l'ordre de création.
   */
  markSent(conversationId: string, heads: Map<string, string | null> = new Map()): ReviewComment[] {
    const drafts = this.list(conversationId).filter((comment) => comment.status === "draft");
    const now = new Date().toISOString();
    const update = this.db.query("UPDATE review_comments SET status = 'sent', sent_at = ?, head_at_send = ? WHERE id = ?");
    for (const draft of drafts) update.run(now, heads.get(draft.worktree_path) ?? null, draft.id);
    return drafts.map((draft) => this.get(draft.id)!);
  }
}
