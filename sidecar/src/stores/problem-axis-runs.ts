import type { Database } from "bun:sqlite";

export type ProblemAxisRunStatus =
  | "running"
  | "interrupted"
  | "failed"
  | "awaiting_validation"
  | "completed"
  | "abandoned";

export type ProblemProgressStatus =
  | "open"
  | "running"
  | "interrupted"
  | "failed"
  | "awaiting_validation"
  | "completed"
  | "abandoned";

export interface ProblemAxisRun {
  id: string;
  problem_id: string;
  plan_index: number;
  mission_id: string | null;
  conversation_id: string | null;
  status: ProblemAxisRunStatus;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProblemAxisState {
  plan_index: number;
  status: "pending" | ProblemAxisRunStatus;
  run: ProblemAxisRun | null;
}

const FINAL = new Set<ProblemAxisRunStatus>(["completed", "abandoned"]);

export function projectProblemProgress(states: ProblemAxisState[]): ProblemProgressStatus {
  if (states.length === 0 || states.every((state) => state.status === "pending")) return "open";
  if (states.every((state) => state.status === "completed" || state.status === "abandoned")) {
    return states.some((state) => state.status === "completed") ? "completed" : "abandoned";
  }
  if (states.some((state) => state.status === "running")) return "running";
  if (states.some((state) => state.status === "awaiting_validation")) return "awaiting_validation";
  if (states.some((state) => state.status === "failed")) return "failed";
  if (states.some((state) => state.status === "interrupted")) return "interrupted";
  return "open";
}

export class ProblemAxisRunStore {
  constructor(private readonly db: Database) {}

  create(input: {
    problemId: string;
    planIndex: number;
    missionId?: string | null;
    conversationId?: string | null;
  }): ProblemAxisRun {
    const problem = this.db.query("SELECT plans_json FROM problems WHERE id = ?")
      .get(input.problemId) as { plans_json: string } | null;
    if (!problem) throw new Error("problématique inconnue");
    const plans = JSON.parse(problem.plans_json) as unknown[];
    if (!Number.isInteger(input.planIndex) || input.planIndex < 0 || input.planIndex >= plans.length) {
      throw new Error("axe de problématique invalide");
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.query(`
      INSERT INTO problem_axis_runs
        (id, problem_id, plan_index, mission_id, conversation_id, status, error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'running', NULL, ?, ?)
    `).run(id, input.problemId, input.planIndex, input.missionId ?? null, input.conversationId ?? null, now, now);
    return this.get(id)!;
  }

  get(id: string): ProblemAxisRun | null {
    return this.db.query("SELECT * FROM problem_axis_runs WHERE id = ?").get(id) as ProblemAxisRun | null;
  }

  transition(id: string, status: ProblemAxisRunStatus, error: string | null = null): ProblemAxisRun | null {
    const current = this.get(id);
    if (!current) return null;
    if (FINAL.has(current.status) && current.status !== status) return current;
    this.db.query(`
      UPDATE problem_axis_runs SET status = ?, error = ?, updated_at = ? WHERE id = ?
    `).run(status, error, new Date().toISOString(), id);
    return this.get(id);
  }

  transitionConversation(conversationId: string, status: ProblemAxisRunStatus, error: string | null = null): number {
    const runs = this.listForConversation(conversationId);
    for (const run of runs) this.transition(run.id, status, error);
    return runs.length;
  }

  completeProblem(problemId: string): number {
    const runs = this.db.query(`
      SELECT * FROM problem_axis_runs WHERE problem_id = ? ORDER BY created_at DESC
    `).all(problemId) as ProblemAxisRun[];
    for (const run of runs) {
      if (!FINAL.has(run.status)) this.transition(run.id, "completed");
    }
    return runs.length;
  }

  statesForProblem(problemId: string, planCount: number, closed = false): ProblemAxisState[] {
    const rows = this.db.query(`
      SELECT runs.* FROM problem_axis_runs runs
      JOIN (
        SELECT plan_index, MAX(created_at) AS latest
        FROM problem_axis_runs WHERE problem_id = ? GROUP BY plan_index
      ) selected ON selected.plan_index = runs.plan_index AND selected.latest = runs.created_at
      WHERE runs.problem_id = ? ORDER BY runs.plan_index
    `).all(problemId, problemId) as ProblemAxisRun[];
    const latest = new Map(rows.map((row) => [row.plan_index, row]));
    return Array.from({ length: planCount }, (_, planIndex) => {
      const run = latest.get(planIndex) ?? null;
      return {
        plan_index: planIndex,
        status: run?.status ?? (closed ? "completed" : "pending"),
        run,
      };
    });
  }

  listForConversation(conversationId: string): ProblemAxisRun[] {
    return this.db.query(`
      SELECT * FROM problem_axis_runs WHERE conversation_id = ? ORDER BY created_at, plan_index
    `).all(conversationId) as ProblemAxisRun[];
  }
}
