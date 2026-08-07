import type { Database } from "bun:sqlite";
import type { Provider } from "./events";
import type { ConversationRunner } from "./runner";
import type { ConversationStore } from "./stores/conversations";
import type { NotificationStore } from "./stores/notifications";
import type { PresetStore } from "./stores/presets";
import type { ProjectStore } from "./stores/projects";
import type { WorkflowStore } from "./stores/workflows";

export interface RoutineInput {
  projectId: string;
  name: string;
  schedule: string;
  workflowId: string | null;
  prompt: string | null;
  presetId: string | null;
  provider: Provider;
  model: string;
  effort: string | null;
  speed: "standard" | "fast" | null;
  orchestrator: boolean;
  enabled: boolean;
}

export interface Routine {
  id: string;
  project_id: string;
  name: string;
  schedule: string;
  workflow_id: string | null;
  prompt: string | null;
  preset_id: string | null;
  provider: Provider;
  model: string;
  effort: string | null;
  speed: "standard" | "fast" | null;
  orchestrator: boolean;
  enabled: boolean;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RoutineRun {
  id: string;
  routine_id: string;
  conversation_id: string | null;
  status: "running" | "done" | "error";
  error: string | null;
  started_at: string;
  completed_at: string | null;
  tokens: number;
}

function fieldMatcher(field: string, min: number, max: number, sundayAlias = false): (value: number) => boolean {
  const accepted = new Set<number>();
  for (const part of field.split(",")) {
    const [range, stepRaw] = part.split("/");
    if (!range || part.split("/").length > 2) throw new Error(`cron invalide : champ « ${field} »`);
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) throw new Error(`cron invalide : pas « ${part} »`);
    let start: number;
    let end: number;
    if (range === "*") {
      start = min;
      end = max;
    } else if (/^\d+-\d+$/.test(range)) {
      [start, end] = range.split("-").map(Number) as [number, number];
    } else if (/^\d+$/.test(range)) {
      start = Number(range);
      end = start;
    } else {
      throw new Error(`cron invalide : champ « ${field} »`);
    }
    if (start < min || end > max || start > end) throw new Error(`cron invalide : plage « ${part} »`);
    for (let value = start; value <= end; value += step) {
      accepted.add(sundayAlias && value === 7 ? 0 : value);
    }
  }
  return (value) => accepted.has(value);
}

export function nextCronDate(schedule: string, after: Date): Date {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("cron invalide : cinq champs attendus");
  const [minute, hour, day, month, weekday] = fields as [string, string, string, string, string];
  const minuteMatches = fieldMatcher(minute, 0, 59);
  const hourMatches = fieldMatcher(hour, 0, 23);
  const dayMatches = fieldMatcher(day, 1, 31);
  const monthMatches = fieldMatcher(month, 1, 12);
  const weekdayMatches = fieldMatcher(weekday, 0, 7, true);
  const candidate = new Date(after);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);
  const limit = 366 * 24 * 60;
  for (let index = 0; index < limit; index += 1) {
    if (
      minuteMatches(candidate.getMinutes())
      && hourMatches(candidate.getHours())
      && monthMatches(candidate.getMonth() + 1)
      && (() => {
        const matchesDay = dayMatches(candidate.getDate());
        const matchesWeekday = weekdayMatches(candidate.getDay());
        if (day === "*") return matchesWeekday;
        if (weekday === "*") return matchesDay;
        return matchesDay || matchesWeekday;
      })()
    ) return candidate;
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  throw new Error("cron sans occurrence dans l'année à venir");
}

function hydrate(row: Record<string, unknown>): Routine {
  return {
    ...row,
    enabled: row.enabled === 1,
    orchestrator: row.orchestrator === 1,
  } as Routine;
}

export class RoutineStore {
  constructor(private readonly db: Database) {
    this.db.query(`
      UPDATE routine_runs
      SET status = 'error', error = 'interrompu (sidecar redémarré)', completed_at = ?,
        tokens = COALESCE((
          SELECT SUM(
            COALESCE(json_extract(events.payload, '$.inputTokens'), 0)
            + COALESCE(json_extract(events.payload, '$.outputTokens'), 0)
          )
          FROM events
          WHERE events.conversation_id = routine_runs.conversation_id
            AND json_valid(events.payload)
            AND json_extract(events.payload, '$.type') = 'usage'
        ), 0)
      WHERE status = 'running'
    `).run(new Date().toISOString());
  }

  get(id: string): Routine | null {
    const row = this.db.query("SELECT * FROM routines WHERE id = ?").get(id) as Record<string, unknown> | null;
    return row ? hydrate(row) : null;
  }

  list(projectId?: string): Routine[] {
    const rows = projectId
      ? this.db.query("SELECT * FROM routines WHERE project_id = ? ORDER BY name COLLATE NOCASE").all(projectId)
      : this.db.query("SELECT * FROM routines ORDER BY next_run_at, name COLLATE NOCASE").all();
    return (rows as Array<Record<string, unknown>>).map(hydrate);
  }

  countByWorkflow(workflowId: string): number {
    const row = this.db.query("SELECT COUNT(*) AS count FROM routines WHERE workflow_id = ?")
      .get(workflowId) as { count: number };
    return row.count;
  }

  runs(routineId: string): RoutineRun[] {
    return this.db.query(`
      SELECT * FROM routine_runs
      WHERE routine_id = ?
      ORDER BY started_at DESC LIMIT 50
    `)
      .all(routineId) as RoutineRun[];
  }

  save(input: RoutineInput, id: string = crypto.randomUUID()): Routine {
    const now = new Date();
    const nextRun = input.enabled ? nextCronDate(input.schedule, now).toISOString() : null;
    this.db.query(`
      INSERT INTO routines (
        id, project_id, name, schedule, workflow_id, prompt, preset_id, provider,
        model, effort, speed, orchestrator, enabled, next_run_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, schedule = excluded.schedule,
        workflow_id = excluded.workflow_id, prompt = excluded.prompt,
        preset_id = excluded.preset_id, provider = excluded.provider,
        model = excluded.model, effort = excluded.effort, speed = excluded.speed,
        orchestrator = excluded.orchestrator, enabled = excluded.enabled,
        next_run_at = excluded.next_run_at, updated_at = excluded.updated_at
    `).run(
      id, input.projectId, input.name, input.schedule, input.workflowId, input.prompt,
      input.presetId, input.provider, input.model, input.effort, input.speed,
      input.orchestrator ? 1 : 0, input.enabled ? 1 : 0, nextRun,
      now.toISOString(), now.toISOString(),
    );
    return this.get(id)!;
  }

  delete(id: string): boolean {
    return this.db.query("DELETE FROM routines WHERE id = ?").run(id).changes === 1;
  }

  due(now: Date): Routine[] {
    return (this.db.query(`
      SELECT * FROM routines
      WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
    `).all(now.toISOString()) as Array<Record<string, unknown>>).map(hydrate);
  }

  reserve(routine: Routine, now: Date, advanceSchedule = true): RoutineRun {
    const runId = crypto.randomUUID();
    const next = advanceSchedule ? nextCronDate(routine.schedule, now).toISOString() : null;
    this.db.transaction(() => {
      if (advanceSchedule) {
        this.db.query("UPDATE routines SET next_run_at = ?, updated_at = ? WHERE id = ?")
          .run(next, now.toISOString(), routine.id);
      }
      this.db.query(`
        INSERT INTO routine_runs (id, routine_id, status, started_at)
        VALUES (?, ?, 'running', ?)
      `).run(runId, routine.id, now.toISOString());
    })();
    return {
      ...(this.db.query("SELECT * FROM routine_runs WHERE id = ?").get(runId) as Omit<RoutineRun, "tokens">),
      tokens: 0,
    };
  }

  attachConversation(runId: string, conversationId: string): void {
    this.db.query("UPDATE routine_runs SET conversation_id = ? WHERE id = ?")
      .run(conversationId, runId);
  }

  complete(runId: string, status: "done" | "error", error?: string): void {
    this.db.query(`
      UPDATE routine_runs
      SET status = ?, error = ?, completed_at = ?,
        tokens = COALESCE((
          SELECT SUM(
            COALESCE(json_extract(events.payload, '$.inputTokens'), 0)
            + COALESCE(json_extract(events.payload, '$.outputTokens'), 0)
          )
          FROM events
          WHERE events.conversation_id = routine_runs.conversation_id
            AND json_valid(events.payload)
            AND json_extract(events.payload, '$.type') = 'usage'
        ), 0)
      WHERE id = ?
    `).run(status, error ?? null, new Date().toISOString(), runId);
  }
}

export class RoutineScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly routines: RoutineStore,
    private readonly workflows: WorkflowStore,
    private readonly presets: PresetStore,
    private readonly projects: ProjectStore,
    private readonly conversations: ConversationStore,
    private readonly runner: ConversationRunner,
    private readonly notifications: NotificationStore,
    private readonly intervalMs = 15_000,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now = new Date()): Promise<void> {
    await Promise.all(this.routines.due(now).map((routine) => this.runScheduled(routine, now)));
  }

  runNow(id: string): RoutineRun | null {
    const routine = this.routines.get(id);
    if (!routine) return null;
    const run = this.routines.reserve(routine, new Date(), false);
    void this.execute(routine, run);
    return run;
  }

  private async runScheduled(routine: Routine, now: Date): Promise<void> {
    const run = this.routines.reserve(routine, now);
    await this.execute(routine, run);
  }

  private async execute(routine: Routine, run: RoutineRun): Promise<void> {
    try {
      const project = this.projects.get(routine.project_id);
      if (!project) throw new Error("projet de routine introuvable");
      const workflow = routine.workflow_id ? this.workflows.get(routine.workflow_id) : null;
      const presetId = workflow?.preset_id ?? routine.preset_id;
      const preset = presetId ? this.presets.get(presetId) : null;
      const config = preset ?? workflow ?? routine;
      const prompt = workflow
        ? `${workflow.prompt.includes(`$${workflow.skill_invocation}`) ? "" : `$${workflow.skill_invocation}\n\n`}${workflow.prompt}`
        : routine.prompt;
      if (!prompt) throw new Error("routine sans workflow ni prompt");
      const conversation = this.conversations.create({
        projectId: routine.project_id,
        provider: config.provider,
        model: config.model,
        effort: config.effort,
        speed: config.speed,
        orchestrator: config.orchestrator,
        subagentPresetId: "subagent_preset_id" in config ? config.subagent_preset_id : null,
        subagentEffort: "subagent_effort" in config ? config.subagent_effort : null,
        routineId: routine.id,
        firstMessage: prompt,
      });
      this.routines.attachConversation(run.id, conversation.id);
      run.conversation_id = conversation.id;
      const outcome = await this.runner.runTurn(conversation.id, prompt, []);
      this.routines.complete(run.id, outcome.state, outcome.error);
      this.notifications.create({
        kind: "routine",
        title: `Routine terminée · ${routine.name}`,
        body: outcome.state === "done" ? "La sortie est disponible dans Pupitre." : outcome.error ?? "La routine a échoué.",
        conversation_id: conversation.id,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "échec de routine";
      this.routines.complete(run.id, "error", message);
      this.notifications.create({
        kind: "routine",
        title: `Routine en échec · ${routine.name}`,
        body: message,
        conversation_id: null,
      });
    }
  }
}
