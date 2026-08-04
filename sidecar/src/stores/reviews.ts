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

export interface ReviewDecisionInput {
  question: string;
  flag_indexes: number[];
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
    const update = this.db.transaction(() => {
      this.db.query("UPDATE review_flags SET status = ? WHERE id = ?").run(status, id);
      this.syncDecisionStatuses(id);
    });
    update();
    return this.getFlag(id);
  }

  setFlagCodeProvider(id: string, provider: Provider): ReviewFlag | null {
    this.db.query("UPDATE review_flags SET code_provider = ? WHERE id = ?").run(provider, id);
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
    const row = this.db.query(`
      SELECT f.*, COALESCE(f.code_provider, r.code_provider, c.provider) AS code_provider
      FROM review_flags f
      JOIN reviews r ON r.id = f.review_id
      JOIN conversations c ON c.id = r.conversation_id
      WHERE f.id = ?
    `).get(id) as ReviewFlag | null;
    return row;
  }

  queueCounters(
    inputs: Array<{ id: string; provider: Provider; model: string; effort: string }>,
  ): ReviewFlag[] {
    const reserve = this.db.transaction(() => {
      const update = this.db.query(`
        UPDATE review_flags
        SET counter_state = 'queued', counter_verdict = NULL, counter_text = NULL,
            counter_provider = ?, counter_model = ?, counter_effort = ?,
            counter_subtask_id = NULL, counter_error = NULL
        WHERE id = ? AND counter_state NOT IN ('queued', 'running')
      `);
      for (const input of inputs) {
        if (update.run(input.provider, input.model, input.effort, input.id).changes !== 1) {
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

  complete(id: string, flags: ReviewFlagInput[], decisions?: ReviewDecisionInput[]): void {
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
           decision, code_provider, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')
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
          defaultCodeProvider,
        );
        stored.push({ ...flag, id: flagId });
      }
      this.insertDecisions(id, stored, decisions);
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
      SELECT f.*, COALESCE(f.code_provider, ?, c.provider) AS code_provider
      FROM review_flags f
      JOIN reviews r ON r.id = f.review_id
      JOIN conversations c ON c.id = r.conversation_id
      WHERE f.review_id = ?
      ORDER BY CASE severity WHEN 'red' THEN 0 WHEN 'orange' THEN 1 ELSE 2 END,
               file ASC, line_start ASC
    `).all(row.code_provider, row.id) as ReviewFlag[];
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

  private insertDecisions(
    reviewId: string,
    flags: Array<ReviewFlagInput & { id: string }>,
    decisions?: ReviewDecisionInput[],
  ): void {
    if (flags.length === 0) return;
    const plans = decisions ?? flags.map((flag, index) => ({
      question: flag.decision ?? decisionQuestion(flag.message),
      flag_indexes: [index],
    }));
    validateDecisionPlans(plans, flags.length);
    const insert = this.db.query(`
      INSERT INTO review_decisions (id, review_id, question, flag_ids, status)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const plan of plans) {
      const group = plan.flag_indexes.map((index) => flags[index]!);
      insert.run(
        crypto.randomUUID(),
        reviewId,
        plan.question,
        JSON.stringify(group.map((flag) => flag.id)),
        "open",
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
      ).all(review.id) as Array<ReviewFlagInput & { id: string; status: ReviewFlagStatus }>;
      const insert = this.db.query(`
        INSERT INTO review_decisions (id, review_id, question, flag_ids, status)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const flag of flags) {
        insert.run(
          crypto.randomUUID(),
          review.id,
          flag.decision ?? decisionQuestion(flag.message),
          JSON.stringify([flag.id]),
          decisionStatus([flag.status]),
        );
      }
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

  private syncDecisionStatuses(flagId: string): void {
    const decisions = this.db.query(`
      SELECT id, flag_ids FROM review_decisions
      WHERE EXISTS (SELECT 1 FROM json_each(flag_ids) WHERE value = ?)
    `).all(flagId) as Array<{ id: string; flag_ids: string }>;
    const getStatus = this.db.query("SELECT status FROM review_flags WHERE id = ?");
    const update = this.db.query("UPDATE review_decisions SET status = ? WHERE id = ?");
    for (const decision of decisions) {
      const ids = JSON.parse(decision.flag_ids) as string[];
      const statuses = ids.map((id) =>
        (getStatus.get(id) as { status: ReviewFlagStatus }).status,
      );
      update.run(decisionStatus(statuses), decision.id);
    }
  }
}

function validateDecisionPlans(plans: ReviewDecisionInput[], flagCount: number): void {
  if (plans.length < Math.min(2, flagCount) || plans.length > 4) {
    throw new Error("une review doit contenir entre 2 et 4 décisions ciblées");
  }
  const indexes = plans.flatMap((plan) => plan.flag_indexes);
  if (
    plans.some((plan) => !plan.question.trim() || plan.flag_indexes.length === 0)
    || indexes.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= flagCount)
    || new Set(indexes).size !== indexes.length
    || indexes.length !== flagCount
  ) {
    throw new Error("les décisions doivent couvrir chaque flag exactement une fois");
  }
}

function decisionStatus(statuses: ReviewFlagStatus[]): ReviewDecision["status"] {
  if (statuses.some((status) => status === "open" || status === "countered")) return "open";
  return statuses.some((status) => status === "acked") ? "acked" : "dismissed";
}

function decisionQuestion(message: string): string {
  return `OK pour accepter ce point : ${message}`;
}
