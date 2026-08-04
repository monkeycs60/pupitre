import type { Database } from "bun:sqlite";
import type { Provider } from "../events";

export type ReviewStatus = "running" | "done" | "error";
export type ReviewSeverity = "red" | "orange" | "grey";
export type ReviewFlagStatus = "open" | "acked" | "dismissed" | "countered";
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
  decision?: string;
}

export interface ReviewDecision {
  id: string;
  review_id: string;
  question: string;
  flag_ids: string[];
  status: "open" | "acked" | "dismissed";
}

export interface ReviewFlag extends ReviewFlagInput {
  id: string;
  review_id: string;
  status: ReviewFlagStatus;
  counter_state: CounterState;
  counter_verdict: CounterVerdict | null;
  counter_text: string | null;
  counter_provider: Provider | null;
  counter_model: string | null;
  counter_effort: string | null;
  counter_subtask_id: string | null;
  counter_error: string | null;
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
  decisions: ReviewDecision[];
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
    this.backfillDecisions();
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
  }): Review {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.query(`
      INSERT INTO reviews
        (id, project_id, conversation_id, git_ref_base, git_ref_head, status,
         review_provider, review_model, review_effort, code_provider, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)
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

  setDecisionStatus(
    id: string,
    status: "acked" | "dismissed",
  ): ReviewDecision | null {
    const decision = this.getDecision(id);
    if (!decision) return null;
    const update = this.db.transaction(() => {
      this.db.query("UPDATE review_decisions SET status = ? WHERE id = ?").run(status, id);
      const flagUpdate = this.db.query("UPDATE review_flags SET status = ? WHERE id = ?");
      for (const flagId of decision.flag_ids) flagUpdate.run(status, flagId);
    });
    update();
    return this.getDecision(id);
  }

  getDecision(id: string): ReviewDecision | null {
    const row = this.db.query("SELECT * FROM review_decisions WHERE id = ?").get(id) as any;
    return row ? this.hydrateDecision(row) : null;
  }

  getFlag(id: string): ReviewFlag | null {
    return this.db.query("SELECT * FROM review_flags WHERE id = ?").get(id) as ReviewFlag | null;
  }

  queueCounters(
    ids: string[],
    provider: Provider,
    model: string,
    effort: string,
  ): ReviewFlag[] {
    const reserve = this.db.transaction(() => {
      const update = this.db.query(`
        UPDATE review_flags
        SET counter_state = 'queued', counter_verdict = NULL, counter_text = NULL,
            counter_provider = ?, counter_model = ?, counter_effort = ?,
            counter_subtask_id = NULL, counter_error = NULL
        WHERE id = ? AND counter_state NOT IN ('queued', 'running')
      `);
      for (const id of ids) {
        if (update.run(provider, model, effort, id).changes !== 1) {
          throw new CounterAlreadyRunningError("un contre-avis est déjà en cours");
        }
      }
      return ids.map((id) => this.getFlag(id)!);
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
      this.db.query(`
        UPDATE review_decisions
        SET status = 'open'
        WHERE EXISTS (
          SELECT 1 FROM json_each(review_decisions.flag_ids) WHERE value = ?
        )
      `).run(id);
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

  gardienStatus(projectId: string, mode: "informatif" | "bloquant"): {
    mode: "informatif" | "bloquant";
    blocked: boolean;
    openRedCount: number;
  } {
    const row = this.db.query(`
      SELECT COUNT(*) AS count
      FROM review_flags f
      JOIN reviews r ON r.id = f.review_id
      WHERE r.project_id = ? AND f.severity = 'red'
        AND f.status IN ('open', 'countered')
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
          (id, review_id, file, line_start, line_end, severity, category, message,
           decision, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')
      `);
      const stored: Array<ReviewFlagInput & { id: string }> = [];
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
          flag.decision ?? decisionQuestion(flag.message),
        );
        stored.push({ ...flag, id: flagId });
      }
      this.insertDecisions(id, stored);
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
    const decisions = this.db.query(
      "SELECT * FROM review_decisions WHERE review_id = ? ORDER BY rowid",
    ).all(row.id).map((decision) => this.hydrateDecision(decision));
    return {
      ...row,
      flags,
      code_provider: row.code_provider ?? this.conversationProvider(row.conversation_id),
      decisions,
    } as Review;
  }

  private insertDecisions(reviewId: string, flags: Array<ReviewFlagInput & { id: string }>): void {
    if (flags.length === 0) return;
    const ranked = [...flags].sort((left, right) =>
      severityWeight(right.severity) - severityWeight(left.severity),
    );
    const groupCount = Math.min(4, ranked.length);
    const groups = Array.from({ length: groupCount }, () => [] as typeof ranked);
    ranked.forEach((flag, index) => groups[index % groupCount]!.push(flag));
    const insert = this.db.query(`
      INSERT INTO review_decisions (id, review_id, question, flag_ids, status)
      VALUES (?, ?, ?, ?, 'open')
    `);
    for (const group of groups) {
      const primary = group[0]!;
      const suffix = group.length > 1 ? ` Cette décision couvre ${group.length} points liés.` : "";
      insert.run(
        crypto.randomUUID(),
        reviewId,
        `${primary.decision ?? decisionQuestion(primary.message)}${suffix}`,
        JSON.stringify(group.map((flag) => flag.id)),
      );
    }
  }

  private backfillDecisions(): void {
    const reviews = this.db.query(`
      SELECT id FROM reviews r
      WHERE EXISTS (SELECT 1 FROM review_flags f WHERE f.review_id = r.id)
        AND NOT EXISTS (SELECT 1 FROM review_decisions d WHERE d.review_id = r.id)
    `).all() as Array<{ id: string }>;
    for (const review of reviews) {
      const flags = this.db.query(
        "SELECT * FROM review_flags WHERE review_id = ?",
      ).all(review.id) as Array<ReviewFlagInput & { id: string }>;
      this.insertDecisions(review.id, flags);
    }
  }

  private hydrateDecision(row: any): ReviewDecision {
    let flagIds: string[] = [];
    try {
      const parsed: unknown = JSON.parse(row.flag_ids);
      if (Array.isArray(parsed) && parsed.every((id) => typeof id === "string")) flagIds = parsed;
    } catch {
      // Une décision corrompue reste visible mais ne peut acquitter aucun flag.
    }
    return { ...row, flag_ids: flagIds } as ReviewDecision;
  }

  private conversationProvider(conversationId: string): Provider {
    const conversation = this.db.query(
      "SELECT provider FROM conversations WHERE id = ?",
    ).get(conversationId) as { provider: Provider } | null;
    return conversation?.provider ?? "codex";
  }
}

function severityWeight(severity: ReviewSeverity): number {
  return severity === "red" ? 3 : severity === "orange" ? 2 : 1;
}

function decisionQuestion(message: string): string {
  return `OK pour accepter ce point : ${message}`;
}
