import type { Database } from "bun:sqlite";
import type { Provider } from "../events";

export type ReviewStatus = "running" | "done" | "error";
export type ReviewSeverity = "red" | "orange" | "grey";
export type ReviewFlagStatus = "open" | "countered" | "agent_running" | "treated" | "ignored" | "resolved";
export type CounterState = "idle" | "queued" | "running" | "done" | "error";
export type CounterVerdict = "confirmed" | "dismissed" | "nuanced";
export class CounterAlreadyRunningError extends Error {}

export interface ReviewFlagInput {
  file: string;
  line_start: number;
  line_end: number;
  severity: ReviewSeverity;
  category: string;
  message: string;
  test_gap?: boolean;
}

export interface ReviewFlag extends ReviewFlagInput {
  id: string;
  review_id: string;
  status: ReviewFlagStatus;
  code_provider: Provider;
  counter_state: CounterState;
  counter_verdict: CounterVerdict | null;
  counter_text: string | null;
  counter_provider: Provider | null;
  counter_model: string | null;
  counter_effort: string | null;
  counter_subtask_id: string | null;
  counter_error: string | null;
  hunk_hash: string | null;
  subtask_id: string | null;
  user_message: string | null;
  test_gap: boolean;
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
  code_provider: Provider;
  scope: string;
  parent_review_id: string | null;
}

export class ReviewStore {
  constructor(private db: Database) {
    // Un scan `running` ne peut pas survivre au process qui l'exécutait.
    this.db.query(`
      UPDATE reviews
      SET status = 'error', error = 'interrompu (sidecar redémarré)', updated_at = ?
      WHERE status = 'running'
    `).run(new Date().toISOString());
    this.db.query(`
      UPDATE review_flags
      SET counter_state = 'error', counter_error = 'interrompu (sidecar redémarré)'
      WHERE counter_state IN ('queued', 'running')
    `).run();
  }

  create(input: {
    projectId: string;
    conversationId: string;
    gitRefBase: string;
    gitRefHead: string;
    provider: Provider;
    model: string;
    effort: string;
    codeProvider?: Provider;
    scope?: string;
    parentReviewId?: string | null;
  }): Review {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.query(`
      INSERT INTO reviews
        (id, project_id, conversation_id, git_ref_base, git_ref_head, status,
         review_provider, review_model, review_effort, code_provider, scope, parent_review_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.projectId,
      input.conversationId,
      input.gitRefBase,
      input.gitRefHead,
      input.provider,
      input.model,
      input.effort,
      input.codeProvider ?? this.conversationProvider(input.conversationId),
      input.scope ?? "worktree",
      input.parentReviewId ?? null,
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

  latestDone(projectId: string, scope: string): Review | null {
    const row = this.db.query(`
      SELECT * FROM reviews
      WHERE project_id = ? AND scope = ? AND status = 'done'
      ORDER BY created_at DESC LIMIT 1
    `).get(projectId, scope) as any;
    return row ? this.hydrate(row) : null;
  }

  copyFlags(reviewId: string, flags: ReviewFlag[]): void {
    const insert = this.db.query(`
      INSERT INTO review_flags (
        id, review_id, file, line_start, line_end, severity, category, message,
        code_provider, is_test_gap, status, counter_state, counter_verdict,
        counter_text, counter_provider, counter_model, counter_effort,
        counter_subtask_id, counter_error, hunk_hash, subtask_id, user_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const flag of flags) {
      insert.run(
        crypto.randomUUID(), reviewId, flag.file, flag.line_start, flag.line_end,
        flag.severity, flag.category, flag.message, flag.code_provider,
        flag.test_gap ? 1 : 0, flag.status, flag.counter_state, flag.counter_verdict,
        flag.counter_text, flag.counter_provider, flag.counter_model, flag.counter_effort,
        flag.counter_subtask_id, flag.counter_error, flag.hunk_hash, flag.subtask_id,
        flag.user_message,
      );
    }
  }

  linkedCommitShas(projectId: string, conversationId: string): string[] {
    const rows = this.db.query(`
      SELECT commit_sha
      FROM commit_links
      WHERE project_id = ? AND conversation_id = ?
      ORDER BY created_at, rowid
    `).all(projectId, conversationId) as Array<{ commit_sha: string }>;
    return rows.map((row) => row.commit_sha);
  }

  /** Conversation ayant produit le plus récent commit visible dans cette review. */
  linkedConversationId(projectId: string, diff: string): string | null {
    const shas = [...diff.matchAll(/^index ([0-9a-f]+)\.\.[0-9a-f]+/gm)]
      .map((match) => match[2])
      .filter((sha): sha is string => Boolean(sha));
    for (const sha of shas) {
      const row = this.db.query(`
        SELECT conversation_id FROM commit_links
        WHERE project_id = ? AND commit_sha = ?
        ORDER BY created_at DESC LIMIT 1
      `).get(projectId, sha) as { conversation_id: string } | null;
      if (row) return row.conversation_id;
    }
    return null;
  }

  listTestingFlags(projectId: string): ReviewFlag[] {
    return this.listByProject(projectId).flatMap((review) => review.flags).filter((flag) => {
      if (flag.status !== "open" && flag.status !== "countered") return false;
      return flag.test_gap;
    });
  }

  ackFlags(ids: string[]): string[] {
    const ack = this.db.transaction(() => {
      const acked: string[] = [];
      const update = this.db.query(`
        UPDATE review_flags SET status = 'treated'
        WHERE id = ? AND status IN ('open', 'countered')
      `);
      for (const id of [...new Set(ids)]) {
        if (update.run(id).changes !== 1) continue;
        acked.push(id);
      }
      return acked;
    });
    return ack();
  }

  setFlagStatus(id: string, status: Exclude<ReviewFlagStatus, "countered">): ReviewFlag | null {
    return this.updateFlag(id, { status });
  }

  setFlagCodeProvider(id: string, provider: Provider): ReviewFlag | null {
    return this.updateFlag(id, { codeProvider: provider });
  }

  updateFlag(
    id: string,
    input: {
      status?: Exclude<ReviewFlagStatus, "countered">;
      codeProvider?: Provider;
      hunkHash?: string | null;
      subtaskId?: string | null;
      userMessage?: string | null;
    },
  ): ReviewFlag | null {
    const update = this.db.transaction(() => {
      const current = this.getFlag(id);
      if (!current) return null;
      if (input.codeProvider && input.codeProvider !== current.code_provider) {
        if (current.counter_state === "queued" || current.counter_state === "running") {
          throw new CounterAlreadyRunningError(
            "l'auteur ne peut pas changer pendant un contre-avis",
          );
        }
        this.db.query(`
          UPDATE review_flags
          SET code_provider = ?,
              status = CASE WHEN status = 'countered' THEN 'open' ELSE status END,
              counter_state = 'idle', counter_verdict = NULL, counter_text = NULL,
              counter_provider = NULL, counter_model = NULL, counter_effort = NULL,
              counter_subtask_id = NULL, counter_error = NULL
          WHERE id = ?
        `).run(input.codeProvider, id);
      }
      if (input.status) {
        this.db.query("UPDATE review_flags SET status = ? WHERE id = ?").run(input.status, id);
      }
      if (input.hunkHash !== undefined || input.subtaskId !== undefined || input.userMessage !== undefined) {
        const fields: Array<[string, string | null]> = [];
        if (input.hunkHash !== undefined) fields.push(["hunk_hash", input.hunkHash]);
        if (input.subtaskId !== undefined) fields.push(["subtask_id", input.subtaskId]);
        if (input.userMessage !== undefined) fields.push(["user_message", input.userMessage]);
        this.db.query(`UPDATE review_flags SET ${fields.map(([field]) => `${field} = ?`).join(", ")} WHERE id = ?`)
          .run(...fields.map(([, value]) => value), id);
      }
      return this.getFlag(id);
    });
    return update();
  }


  getFlag(id: string): ReviewFlag | null {
    const row = this.db.query(`
      SELECT f.*, COALESCE(f.code_provider, r.code_provider, c.provider) AS code_provider
      FROM review_flags f
      JOIN reviews r ON r.id = f.review_id
      JOIN conversations c ON c.id = r.conversation_id
      WHERE f.id = ?
    `).get(id) as any;
    return row ? hydrateFlag(row) : null;
  }

  queueCounters(
    inputs: Array<{
      id: string;
      provider: Provider;
      model: string;
      effort: string;
      codeProvider: Provider;
    }>,
  ): ReviewFlag[] {
    const reserve = this.db.transaction(() => {
      const update = this.db.query(`
        UPDATE review_flags
        SET status = CASE WHEN status = 'countered' THEN 'open' ELSE status END,
            counter_state = 'queued', counter_verdict = NULL, counter_text = NULL,
            counter_provider = ?, counter_model = ?, counter_effort = ?,
            code_provider = ?, counter_subtask_id = NULL, counter_error = NULL
        WHERE id = ? AND counter_state NOT IN ('queued', 'running')
      `);
      for (const input of inputs) {
        if (update.run(
          input.provider,
          input.model,
          input.effort,
          input.codeProvider,
          input.id,
        ).changes !== 1) {
          throw new CounterAlreadyRunningError("un contre-avis est déjà en cours");
        }
      }
      return inputs.map((input) => this.getFlag(input.id)!);
    });
    return reserve();
  }

  beginCounter(id: string, subtaskId: string): void {
    this.db.query(`
      UPDATE review_flags
      SET counter_state = 'running', counter_subtask_id = ?, counter_error = NULL
      WHERE id = ?
    `).run(subtaskId, id);
  }

  completeCounter(id: string, verdict: CounterVerdict, text: string): void {
    const complete = this.db.transaction(() => {
      this.db.query(`
        UPDATE review_flags
        SET status = 'countered', counter_state = 'done', counter_verdict = ?,
            counter_text = ?, counter_error = NULL
        WHERE id = ?
      `).run(verdict, text, id);
    });
    complete();
  }

  failCounter(id: string, error: string): void {
    this.db.query(`
      UPDATE review_flags
      SET counter_state = 'error', counter_error = ?
      WHERE id = ?
    `).run(error, id);
  }

  reviewStatus(projectId: string): {
    openBySeverity: Record<ReviewSeverity, number>;
    running: { reviewId: string; zoneDone: number; zoneTotal: number } | null;
  } {
    const rows = this.db.query(`
      SELECT severity, COUNT(*) AS count FROM review_flags f
      JOIN reviews r ON r.id = f.review_id
      WHERE r.project_id = ? AND f.status IN ('open', 'countered', 'agent_running')
      GROUP BY severity
    `).all(projectId) as Array<{ severity: ReviewSeverity; count: number | bigint }>;
    const openBySeverity: Record<ReviewSeverity, number> = { red: 0, orange: 0, grey: 0 };
    for (const row of rows) openBySeverity[row.severity] = Number(row.count);
    return { openBySeverity, running: null };
  }

  setDiff(id: string, base: string, head: string, diff: string): void {
    this.db.query(`
      UPDATE reviews
      SET git_ref_base = ?, git_ref_head = ?, diff_text = ?, updated_at = ?
      WHERE id = ?
    `).run(base, head, diff, new Date().toISOString(), id);
  }

  complete(id: string, flags: Array<ReviewFlagInput & { hunk_hash?: string | null }>): void {
    const complete = this.db.transaction(() => {
      const review = this.db.query(
        "SELECT code_provider, conversation_id FROM reviews WHERE id = ?",
      ).get(id) as { code_provider: Provider | null; conversation_id: string } | null;
      if (!review) throw new Error("review inconnue");
      const defaultCodeProvider = review.code_provider
        ?? this.conversationProvider(review.conversation_id);
      const insert = this.db.query(`
        INSERT INTO review_flags
          (id, review_id, file, line_start, line_end, severity, category, message,
           code_provider, is_test_gap, hunk_hash, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')
      `);
      for (const flag of flags) {
        const flagId = crypto.randomUUID();
        insert.run(
          flagId,
          id,
          flag.file,
          flag.line_start,
          flag.line_end,
          flag.severity,
          flag.category,
          flag.message,
          defaultCodeProvider,
          (flag.test_gap ?? inferTestGap(flag.category, flag.message)) ? 1 : 0,
          flag.hunk_hash ?? null,
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
    const flags = (this.db.query(`
      SELECT f.*, COALESCE(f.code_provider, ?, c.provider) AS code_provider
      FROM review_flags f
      JOIN reviews r ON r.id = f.review_id
      JOIN conversations c ON c.id = r.conversation_id
      WHERE f.review_id = ?
      ORDER BY CASE severity WHEN 'red' THEN 0 WHEN 'orange' THEN 1 ELSE 2 END,
               file ASC, line_start ASC
    `).all(row.code_provider, row.id) as any[]).map(hydrateFlag);
    return {
      ...row,
      flags,
      code_provider: row.code_provider ?? this.conversationProvider(row.conversation_id),
    } as Review;
  }


  private conversationProvider(conversationId: string): Provider {
    const conversation = this.db.query(
      "SELECT provider FROM conversations WHERE id = ?",
    ).get(conversationId) as { provider: Provider } | null;
    return conversation?.provider ?? "codex";
  }

}

function hydrateFlag(row: any): ReviewFlag {
  return { ...row, test_gap: row.is_test_gap === 1 } as ReviewFlag;
}

function inferTestGap(category: string, message: string): boolean {
  const value = `${category} ${message}`;
  return /(?:absence|manque|sans|non)[^\n]{0,48}test|test[^\n]{0,48}(?:absent|manquant|critique)|test coverage|coverage[^\n]{0,32}test|couverture[^\n]{0,32}(?:test|régression)/i
    .test(value);
}
