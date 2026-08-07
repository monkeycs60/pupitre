import type { Database } from "bun:sqlite";
import type { AppEvent } from "./events";
import type { GitLinkedCommit, GitProjectService } from "./git";
import type { ProjectStore } from "./stores/projects";

const ACTIVE_STEP_MS = 10 * 60_000;
const MAX_ACTIVE_STEPS = 143;
const MAX_FOCUS_MULTIPLIER = 1 + MAX_ACTIVE_STEPS * 0.03;
const COMPLEXITY_MULTIPLIERS = [1, 1.05, 1.1, 1.2, 1.3, 1.45, 1.6] as const;

export interface GamificationConversation {
  conversationId: string;
  complexity: number;
  multiplier: number;
  inputTokens: number;
  outputTokens: number;
  commits: number;
  pushes: number;
  additions: number;
  deletions: number;
  xp: number;
}

export interface GamificationPeriod {
  activeMs: number;
  inputTokens: number;
  outputTokens: number;
  conversations: number;
  projects: number;
  commits: number;
  pushes: number;
  additions: number;
  deletions: number;
  xp: number;
  complexity: Record<string, number>;
}

export interface GamificationSnapshot {
  xp: number;
  level: number;
  levelXp: number;
  nextLevelXp: number;
  progress: number;
  activeMsToday: number;
  focusMultiplier: number;
  today: GamificationPeriod;
  week: GamificationPeriod;
  conversations: Record<string, GamificationConversation>;
}

interface ConversationRow {
  id: string;
  project_id: string;
}

interface EventRow {
  id: number | bigint;
  conversation_id: string;
  payload: string;
  created_at: string;
}

interface UsageRow {
  id: number;
  conversationId: string;
  projectId: string;
  inputTokens: number;
  outputTokens: number;
  createdAt: string;
  completed: boolean;
}

interface ConversationBuild {
  projectId: string;
  inputTokens: number;
  outputTokens: number;
  usage: UsageRow[];
  text: string;
  toolCount: number;
  subtaskCount: number;
  commits: GitLinkedCommit[];
}

interface AwardRow {
  source_key: string;
  kind: string;
  project_id: string | null;
  conversation_id: string | null;
  base_xp: number;
  multiplier: number;
  xp: number;
  day: string;
  created_at: string;
}

function localDay(value = new Date()): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function weekStart(value = new Date()): string {
  const date = new Date(value);
  const day = date.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + mondayOffset);
  return localDay(date);
}

function periodContains(value: string, start: string, end: string): boolean {
  const day = localDay(new Date(value));
  return day >= start && day <= end;
}

function focusMultiplier(activeMs: number): number {
  const steps = Math.min(MAX_ACTIVE_STEPS, Math.floor(Math.max(0, activeMs) / ACTIVE_STEP_MS));
  return Number((1 + steps * 0.03).toFixed(2));
}

function complexityMultiplier(complexity: number): number {
  return COMPLEXITY_MULTIPLIERS[Math.max(0, Math.min(6, complexity))] ?? 1;
}

function tokenXp(inputTokens: number, outputTokens: number): number {
  // L'input est volontairement moins rémunérateur : il mesure souvent le
  // contexte ré-ingéré plutôt qu'un travail nouveau.
  const input = Math.log1p(Math.max(0, inputTokens) / 5_000) * 4;
  const output = Math.log1p(Math.max(0, outputTokens) / 1_000) * 7;
  return Math.max(1, Math.round(input + output));
}

function levelFloor(level: number): number {
  if (level <= 1) return 0;
  return Math.round(250 * Math.pow(level - 1, 1.35));
}

function levelForXp(xp: number): { level: number; levelXp: number; nextLevelXp: number; progress: number } {
  let level = 1;
  while (level < 1_000 && levelFloor(level + 1) <= xp) level += 1;
  const levelXp = levelFloor(level);
  const nextLevelXp = levelFloor(level + 1);
  const progress = Math.max(0, Math.min(1, (xp - levelXp) / Math.max(1, nextLevelXp - levelXp)));
  return { level, levelXp, nextLevelXp, progress };
}

function blankPeriod(): GamificationPeriod {
  return {
    activeMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    conversations: 0,
    projects: 0,
    commits: 0,
    pushes: 0,
    additions: 0,
    deletions: 0,
    xp: 0,
    complexity: { C0: 0, C1: 0, C2: 0, C3: 0, C4: 0, C5: 0, C6: 0 },
  };
}

function parseEvent(payload: string): AppEvent | null {
  try {
    return JSON.parse(payload) as AppEvent;
  } catch {
    return null;
  }
}

export class GamificationService {
  constructor(
    private db: Database,
    private projects: ProjectStore,
    private git: GitProjectService,
  ) {}

  addActiveTime(day: string, activeMs: number): void {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("jour d'activité invalide");
    const bounded = Math.min(60_000, Math.max(0, Math.floor(activeMs)));
    if (bounded > 0) {
      this.db.query(`
        INSERT INTO gamification_activity (day, active_ms, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(day) DO UPDATE SET
          active_ms = active_ms + excluded.active_ms,
          updated_at = excluded.updated_at
      `).run(day, bounded, new Date().toISOString());
    }
  }

  snapshot(projectId?: string): GamificationSnapshot {
    const built = this.build(projectId);
    this.awardMissing(built);

    const totalXp = Number((this.db.query(
      "SELECT COALESCE(SUM(xp), 0) AS xp FROM gamification_awards",
    ).get() as { xp: number | bigint }).xp);
    const today = localDay();
    const start = weekStart();
    const allAwards = this.db.query(
      "SELECT * FROM gamification_awards ORDER BY created_at",
    ).all() as AwardRow[];
    const activeRows = this.db.query(
      "SELECT day, active_ms FROM gamification_activity WHERE day >= ?",
    ).all(start) as Array<{ day: string; active_ms: number | bigint }>;
    const activeByDay = new Map(activeRows.map((row) => [row.day, Number(row.active_ms)]));
    const todayPeriod = this.period(built, allAwards, today, today, activeByDay);
    const weekPeriod = this.period(built, allAwards, start, today, activeByDay);
    const levels = levelForXp(totalXp);
    const conversations: Record<string, GamificationConversation> = {};
    for (const [id, value] of built.metrics) {
      if (projectId && value.projectId !== projectId) continue;
      const awards = allAwards.filter((award) => award.conversation_id === id);
      conversations[id] = {
        conversationId: id,
        complexity: built.complexity.get(id) ?? 0,
        multiplier: complexityMultiplier(built.complexity.get(id) ?? 0),
        inputTokens: value.inputTokens,
        outputTokens: value.outputTokens,
        commits: value.commits.length,
        pushes: value.commits.filter((commit) => commit.pushed).length,
        additions: value.commits.reduce((sum, commit) => sum + commit.additions, 0),
        deletions: value.commits.reduce((sum, commit) => sum + commit.deletions, 0),
        xp: awards.reduce((sum, award) => sum + Number(award.xp), 0),
      };
    }
    const activeMsToday = activeByDay.get(today) ?? this.activeMs(today);
    return {
      xp: totalXp,
      ...levels,
      activeMsToday,
      focusMultiplier: focusMultiplier(activeMsToday),
      today: todayPeriod,
      week: weekPeriod,
      conversations,
    };
  }

  private build(projectId?: string): {
    metrics: Map<string, ConversationBuild>;
    complexity: Map<string, number>;
    usage: UsageRow[];
    commits: GitLinkedCommit[];
  } {
    const conversationRows = this.db.query(
      `SELECT id, project_id FROM conversations ${projectId ? "WHERE project_id = ?" : ""}`,
    ).all(...(projectId ? [projectId] : [])) as ConversationRow[];
    const projectByConversation = new Map(conversationRows.map((row) => [row.id, row.project_id]));
    const parentByEventConversation = new Map<string, string>();
    for (const row of conversationRows) parentByEventConversation.set(row.id, row.id);
    const subtasks = this.db.query(
      `SELECT id, conversation_id FROM subtasks ${projectId ? "WHERE conversation_id IN (SELECT id FROM conversations WHERE project_id = ?)" : ""}`,
    ).all(...(projectId ? [projectId] : [])) as Array<{ id: string; conversation_id: string }>;
    for (const row of subtasks) parentByEventConversation.set(row.id, row.conversation_id);

    const metrics = new Map<string, ConversationBuild>();
    for (const row of conversationRows) {
      metrics.set(row.id, {
        projectId: row.project_id,
        inputTokens: 0,
        outputTokens: 0,
        usage: [],
        text: "",
        toolCount: 0,
        subtaskCount: 0,
        commits: [],
      });
    }
    const usage: UsageRow[] = [];
    const events = this.db.query("SELECT id, conversation_id, payload, created_at FROM events ORDER BY id").all() as EventRow[];
    const pendingUsageByStream = new Map<string, UsageRow[]>();
    for (const row of events) {
      const parentId = parentByEventConversation.get(row.conversation_id);
      if (!parentId) continue;
      const metric = metrics.get(parentId);
      if (!metric) continue;
      const event = parseEvent(row.payload);
      if (!event) continue;
      if (event.type === "status") {
        if (event.state === "running") {
          pendingUsageByStream.set(row.conversation_id, []);
        } else {
          for (const usage of pendingUsageByStream.get(row.conversation_id) ?? []) usage.completed = true;
          pendingUsageByStream.delete(row.conversation_id);
        }
        continue;
      }
      if (event.type === "usage") {
        const item: UsageRow = {
          id: Number(row.id),
          conversationId: parentId,
          projectId: metric.projectId,
          inputTokens: Math.max(0, Number(event.inputTokens) || 0),
          outputTokens: Math.max(0, Number(event.outputTokens) || 0),
          createdAt: row.created_at,
          completed: false,
        };
        metric.inputTokens += item.inputTokens;
        metric.outputTokens += item.outputTokens;
        metric.usage.push(item);
        usage.push(item);
        const pending = pendingUsageByStream.get(row.conversation_id) ?? [];
        pending.push(item);
        pendingUsageByStream.set(row.conversation_id, pending);
      } else if (event.type === "user-message" || event.type === "text-final") {
        metric.text += ` ${event.text}`;
      } else if (event.type === "tool-start") {
        metric.toolCount += 1;
        metric.text += ` ${event.toolName}`;
      } else if (event.type === "subtask-ref") {
        metric.subtaskCount += 1;
      }
    }

    const commits = this.git.linkedCommitStats(projectId);
    for (const commit of commits) metrics.get(commit.conversationId)?.commits.push(commit);
    const complexity = new Map<string, number>();
    for (const [id, metric] of metrics) complexity.set(id, this.estimateComplexity(metric));
    return { metrics, complexity, usage, commits };
  }

  private estimateComplexity(metric: ConversationBuild): number {
    const files = metric.commits.reduce((sum, commit) => sum + commit.files, 0);
    const additions = metric.commits.reduce((sum, commit) => sum + commit.additions, 0);
    const deletions = metric.commits.reduce((sum, commit) => sum + commit.deletions, 0);
    const text = metric.text.toLocaleLowerCase("fr-FR");
    let complexity = 0;
    if (metric.text.length > 400 || metric.toolCount >= 3) complexity += 1;
    if (files >= 2 || metric.subtaskCount > 0) complexity += 1;
    if (files >= 5 || additions + deletions >= 250) complexity += 1;
    if (files >= 10 || additions + deletions >= 800) complexity += 1;
    if (/api|contrat|migration|schema|schéma|database|base de données|auth|permission|concurr|architecture|refactor|réseau/.test(text)) complexity += 1;
    if (/feature|fonctionnal|refonte|système|cross-provider|multi[- ]?projet/.test(text)) complexity += 1;
    return Math.min(6, complexity);
  }

  private awardMissing(built: {
    metrics: Map<string, ConversationBuild>;
    complexity: Map<string, number>;
    usage: UsageRow[];
    commits: GitLinkedCommit[];
  }): void {
    const award = this.db.query(`
      INSERT OR IGNORE INTO gamification_awards
        (source_key, kind, project_id, conversation_id, base_xp, multiplier, xp, day, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const now = new Date().toISOString();
    const add = (
      sourceKey: string,
      kind: string,
      projectId: string,
      conversationId: string,
      baseXp: number,
      day: string,
      multiplier: number,
    ) => {
      award.run(
        sourceKey,
        kind,
        projectId,
        conversationId,
        baseXp,
        multiplier,
        Math.max(1, Math.round(baseXp * multiplier)),
        day,
        now,
      );
    };
    for (const item of built.usage) {
      // Codex app-server publie plusieurs snapshots d'usage pendant un tour.
      // On conserve les métriques visibles en direct, mais on ne transforme
      // les tokens en XP qu'au statut terminal du tour.
      if (!item.completed) {
        this.db.query("DELETE FROM gamification_awards WHERE source_key = ? AND kind = 'tokens'")
          .run(`usage:${item.id}`);
        continue;
      }
      const complexity = built.complexity.get(item.conversationId) ?? 0;
      const day = localDay(new Date(item.createdAt));
      add(
        `usage:${item.id}`,
        "tokens",
        item.projectId,
        item.conversationId,
        tokenXp(item.inputTokens, item.outputTokens),
        day,
        complexityMultiplier(complexity) * focusMultiplier(this.activeMs(day)),
      );
    }
    for (const commit of built.commits) {
      const complexity = built.complexity.get(commit.conversationId) ?? 0;
      const multiplier = complexityMultiplier(complexity) * focusMultiplier(this.activeMs(localDay(new Date(commit.linkedAt))));
      add(
        `commit:${commit.projectId}:${commit.sha}`,
        "commit",
        commit.projectId,
        commit.conversationId,
        20,
        localDay(new Date(commit.linkedAt)),
        multiplier,
      );
      if (commit.pushed) {
        add(
          `push:${commit.projectId}:${commit.sha}`,
          "push",
          commit.projectId,
          commit.conversationId,
          15,
          localDay(new Date(commit.linkedAt)),
          multiplier,
        );
      }
    }
  }

  private period(
    built: { metrics: Map<string, ConversationBuild>; complexity: Map<string, number>; usage: UsageRow[]; commits: GitLinkedCommit[] },
    awards: AwardRow[],
    start: string,
    end: string,
    activeByDay: Map<string, number>,
  ): GamificationPeriod {
    const period = blankPeriod();
    const conversationIds = new Set<string>();
    const projectIds = new Set<string>();
    for (const usage of built.usage) {
      if (!periodContains(usage.createdAt, start, end)) continue;
      conversationIds.add(usage.conversationId);
      projectIds.add(usage.projectId);
      period.inputTokens += usage.inputTokens;
      period.outputTokens += usage.outputTokens;
    }
    for (const commit of built.commits) {
      if (!periodContains(commit.linkedAt, start, end)) continue;
      conversationIds.add(commit.conversationId);
      projectIds.add(commit.projectId);
      period.commits += 1;
      if (commit.pushed) period.pushes += 1;
      period.additions += commit.additions;
      period.deletions += commit.deletions;
    }
    for (const [id, complexity] of built.complexity) {
      if (conversationIds.has(id)) period.complexity[`C${complexity}`] = (period.complexity[`C${complexity}`] ?? 0) + 1;
    }
    for (const [day, activeMs] of activeByDay) {
      if (day >= start && day <= end) period.activeMs += activeMs;
    }
    period.conversations = conversationIds.size;
    period.projects = projectIds.size;
    period.xp = awards
      .filter((award) => award.day >= start && award.day <= end)
      .reduce((sum, award) => sum + Number(award.xp), 0);
    return period;
  }

  private activeMs(day: string): number {
    const row = this.db.query(
      "SELECT active_ms FROM gamification_activity WHERE day = ?",
    ).get(day) as { active_ms: number | bigint } | null;
    return row ? Number(row.active_ms) : 0;
  }
}

export { ACTIVE_STEP_MS, MAX_ACTIVE_STEPS, MAX_FOCUS_MULTIPLIER, focusMultiplier };
