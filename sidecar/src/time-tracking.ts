import type { Database } from "bun:sqlite";
import type { GitProjectService } from "./git";
import type { ProjectStore } from "./stores/projects";

/** Un niveau vaut une heure passée. Rien à calibrer, rien à pondérer. */
const LEVEL_MS = 3_600_000;
const MILESTONE_HOURS = [10, 25, 50, 100, 250, 500] as const;
/** Deux tranches séparées de moins d'une seconde sont le même moment. */
const MERGE_GAP_MS = 1_000;
/** Garde-fou d'écriture : l'UI envoie des tranches courtes, jamais des blocs. */
const MAX_PRESENCE_SLICE_MS = 30 * 60_000;
/** Un tour laissé ouvert par une machine endormie ne doit pas gonfler le total. */
const MAX_AGENT_SEGMENT_MS = 30 * 60_000;
const SYNC_WATERMARK_KEY = "time-tracking:last-event-id";
const BACKFILL_KEY = "time-tracking:backfilled-at";

export interface Span {
  start: number;
  end: number;
}

export interface TimeCounter {
  ms: number;
  level: number;
  levelMs: number;
  progress: number;
  todayMs: number;
}

export interface TimeProjectSummary {
  projectId: string;
  name: string;
  user: TimeCounter;
  agent: TimeCounter;
  nextMilestone: number | null;
  msToNextMilestone: number | null;
}

export interface TimeMilestone {
  hours: number;
  reached: boolean;
  reachedOn: string | null;
}

export interface TimeSnapshot {
  scope: "project" | "global";
  projectId: string | null;
  projectCount: number;
  user: TimeCounter;
  agent: TimeCounter;
  supervisionMs: number;
  writingMs: number;
  agentAloneMs: number;
  weekUserMs: number;
  weekAgentMs: number;
  previousWeekUserMs: number;
  activeDays: number;
  commits: number;
  turnCount: number;
  backfilledMs: number;
  nextMilestone: number | null;
  msToNextMilestone: number | null;
  milestones: TimeMilestone[];
  projects: TimeProjectSummary[];
  conversations: Record<string, { userMs: number; agentMs: number }>;
}

export interface PresenceSlice {
  projectId: string;
  conversationId?: string | null;
  startedAt: string;
  endedAt: string;
}

interface EntryRow {
  project_id: string;
  conversation_id: string | null;
  source: string;
  started_at: string;
  ended_at: string;
  day: string;
  backfilled: number;
}

/** Fusionne les tranches qui se touchent ou se chevauchent. */
export function merge(spans: Span[]): Span[] {
  if (spans.length === 0) return [];
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const merged: Span[] = [{ ...sorted[0]! }];
  for (const span of sorted.slice(1)) {
    const last = merged[merged.length - 1]!;
    if (span.start - last.end <= MERGE_GAP_MS) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

/** Partie commune à deux séries déjà fusionnées : la supervision. */
export function intersect(left: Span[], right: Span[]): Span[] {
  const a = merge(left);
  const b = merge(right);
  const out: Span[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const start = Math.max(a[i]!.start, b[j]!.start);
    const end = Math.min(a[i]!.end, b[j]!.end);
    if (end > start) out.push({ start, end });
    if (a[i]!.end < b[j]!.end) i += 1;
    else j += 1;
  }
  return out;
}

function total(spans: Span[]): number {
  return spans.reduce((sum, span) => sum + (span.end - span.start), 0);
}

function clip(spans: Span[], window: Span): Span[] {
  return intersect(spans, [window]);
}

function localDay(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dayWindow(day: Date): Span {
  const start = new Date(day);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start: start.getTime(), end: end.getTime() };
}

function weekWindow(offsetWeeks = 0): Span {
  const start = new Date();
  const weekday = start.getDay();
  start.setDate(start.getDate() + (weekday === 0 ? -6 : 1 - weekday) - offsetWeeks * 7);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return { start: start.getTime(), end: end.getTime() };
}

function counter(spans: Span[], todaySpans: Span[]): TimeCounter {
  const ms = total(spans);
  return {
    ms,
    level: Math.floor(ms / LEVEL_MS),
    levelMs: ms % LEVEL_MS,
    progress: (ms % LEVEL_MS) / LEVEL_MS,
    todayMs: total(todaySpans),
  };
}

function nextMilestoneFor(ms: number): { hours: number | null; remaining: number | null } {
  const hours = ms / LEVEL_MS;
  const next = MILESTONE_HOURS.find((step) => step > hours);
  if (next === undefined) return { hours: null, remaining: null };
  return { hours: next, remaining: next * LEVEL_MS - ms };
}

export class TimeTrackingService {
  constructor(
    private db: Database,
    private projects: ProjectStore,
    private git: GitProjectService,
  ) {}

  /**
   * Une tranche de présence envoyée par l'UI. Les tranches successives d'un
   * même moment se recollent à la lecture ; la clé d'unicité rend le rejeu
   * d'un flush réseau inoffensif.
   */
  addPresence(slice: PresenceSlice): void {
    const start = Date.parse(slice.startedAt);
    const end = Date.parse(slice.endedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error("horodatage invalide");
    if (end <= start) throw new Error("tranche de présence vide");
    if (end - start > MAX_PRESENCE_SLICE_MS) throw new Error("tranche de présence trop longue");
    if (!this.projects.get(slice.projectId)) throw new Error("projet inconnu");
    this.db.query(`
      INSERT OR IGNORE INTO time_entries
        (source_key, project_id, conversation_id, source, started_at, ended_at, day, backfilled)
      VALUES (?, ?, ?, 'presence', ?, ?, ?, 0)
    `).run(
      `presence:${slice.projectId}:${new Date(start).toISOString()}`,
      slice.projectId,
      slice.conversationId ?? null,
      new Date(start).toISOString(),
      new Date(end).toISOString(),
      localDay(new Date(start)),
    );
  }

  snapshot(projectId?: string): TimeSnapshot {
    this.syncAgentSegments();
    const rows = this.rows(projectId);
    const today = dayWindow(new Date());
    const week = weekWindow();
    const previousWeek = weekWindow(1);

    // Fusion et non somme : une personne n'est présente que sur un projet à la
    // fois, donc rien ne se chevauche en pratique — mais deux fenêtres ouvertes
    // ne doivent pas pouvoir créditer la même minute deux fois.
    const user = merge(rows.filter((row) => row.source === "presence").map(toSpan));
    const agent = merge(rows.filter((row) => row.source === "agent").map(toSpan));
    const supervision = intersect(user, agent);

    const byProject = new Map<string, { presence: Span[]; agent: Span[] }>();
    for (const row of rows) {
      const entry = byProject.get(row.project_id) ?? { presence: [], agent: [] };
      (row.source === "presence" ? entry.presence : entry.agent).push(toSpan(row));
      byProject.set(row.project_id, entry);
    }
    const projects: TimeProjectSummary[] = [];
    for (const [id, entry] of byProject) {
      const project = this.projects.get(id);
      if (!project) continue;
      const presenceSpans = merge(entry.presence);
      const agentSpans = merge(entry.agent);
      const milestone = nextMilestoneFor(total(presenceSpans));
      projects.push({
        projectId: id,
        name: project.name,
        user: counter(presenceSpans, clip(presenceSpans, today)),
        agent: counter(agentSpans, clip(agentSpans, today)),
        nextMilestone: milestone.hours,
        msToNextMilestone: milestone.remaining,
      });
    }
    projects.sort((a, b) => b.user.ms - a.user.ms);

    const conversations: Record<string, { userMs: number; agentMs: number }> = {};
    const byConversation = new Map<string, { presence: Span[]; agent: Span[] }>();
    for (const row of rows) {
      if (!row.conversation_id) continue;
      const entry = byConversation.get(row.conversation_id) ?? { presence: [], agent: [] };
      (row.source === "presence" ? entry.presence : entry.agent).push(toSpan(row));
      byConversation.set(row.conversation_id, entry);
    }
    for (const [id, entry] of byConversation) {
      conversations[id] = {
        userMs: total(merge(entry.presence)),
        agentMs: total(merge(entry.agent)),
      };
    }

    const userMs = total(user);
    const milestone = nextMilestoneFor(userMs);
    const activeDays = new Set(
      rows.filter((row) => row.source === "presence").map((row) => row.day),
    ).size;

    return {
      scope: projectId ? "project" : "global",
      projectId: projectId ?? null,
      projectCount: projects.length,
      user: counter(user, clip(user, today)),
      agent: counter(agent, clip(agent, today)),
      supervisionMs: total(supervision),
      writingMs: userMs - total(supervision),
      agentAloneMs: total(agent) - total(supervision),
      weekUserMs: total(clip(user, week)),
      weekAgentMs: total(clip(agent, week)),
      previousWeekUserMs: total(clip(user, previousWeek)),
      activeDays,
      commits: this.git.linkedCommitStats(projectId).length,
      turnCount: rows.filter((row) => row.source === "agent").length,
      backfilledMs: total(merge(
        rows.filter((row) => row.source === "presence" && row.backfilled === 1).map(toSpan),
      )),
      nextMilestone: milestone.hours,
      msToNextMilestone: milestone.remaining,
      milestones: this.milestones(user),
      projects,
      conversations,
    };
  }

  /**
   * Ce qu'un tour a coûté en temps humain : la présence pendant sa fenêtre,
   * pas sa durée. Clé = l'horodatage de départ du tour, celui que porte
   * l'événement `turn-timing`.
   */
  conversationTurns(conversationId: string): Record<string, number> {
    this.syncAgentSegments();
    const conversation = this.db.query(
      "SELECT project_id FROM conversations WHERE id = ?",
    ).get(conversationId) as { project_id: string } | null;
    if (!conversation) return {};
    const presence = merge(
      (this.db.query(
        "SELECT started_at, ended_at FROM time_entries WHERE project_id = ? AND source = 'presence'",
      ).all(conversation.project_id) as Array<{ started_at: string; ended_at: string }>)
        .map(toSpan),
    );
    const turns = this.db.query(
      "SELECT started_at, ended_at FROM time_entries WHERE conversation_id = ? AND source = 'agent'",
    ).all(conversationId) as Array<{ started_at: string; ended_at: string }>;
    const out: Record<string, number> = {};
    for (const turn of turns) {
      out[turn.started_at] = total(intersect(presence, [toSpan(turn)]));
    }
    return out;
  }

  private milestones(user: Span[]): TimeMilestone[] {
    const spans = merge(user);
    return MILESTONE_HOURS.map((hours) => {
      const threshold = hours * LEVEL_MS;
      let running = 0;
      let reachedOn: string | null = null;
      for (const span of spans) {
        running += span.end - span.start;
        if (running >= threshold) {
          reachedOn = new Date(span.end).toISOString();
          break;
        }
      }
      return { hours, reached: reachedOn !== null, reachedOn };
    });
  }

  private rows(projectId?: string): EntryRow[] {
    return this.db.query(
      `SELECT project_id, conversation_id, source, started_at, ended_at, day, backfilled
       FROM time_entries ${projectId ? "WHERE project_id = ?" : ""}
       ORDER BY started_at`,
    ).all(...(projectId ? [projectId] : [])) as EntryRow[];
  }

  /**
   * L'horloge agent n'a pas de chemin d'écriture propre : elle se déduit des
   * `turn-timing` déjà persistés, ce qui la rend exacte sur l'historique comme
   * sur le direct. Le filigrane évite de relire toute la table à chaque appel.
   */
  syncAgentSegments(): void {
    const watermark = Number(this.setting(SYNC_WATERMARK_KEY) ?? "0");
    const events = this.db.query(`
      SELECT e.id, e.conversation_id, e.payload, c.project_id
      FROM events e
      JOIN conversations c ON c.id = e.conversation_id
      WHERE e.id > ?
        AND json_valid(e.payload)
        AND json_extract(e.payload, '$.type') = 'turn-timing'
        AND json_extract(e.payload, '$.phase') = 'completed'
      ORDER BY e.id
    `).all(watermark) as Array<{
      id: number | bigint; conversation_id: string; payload: string; project_id: string;
    }>;
    const highest = Number(this.db.query("SELECT COALESCE(MAX(id), 0) AS id FROM events")
      .get() as { id: number | bigint }).id;
    if (events.length === 0) {
      if (highest > watermark) this.setSetting(SYNC_WATERMARK_KEY, String(highest));
      return;
    }
    const insert = this.db.query(`
      INSERT OR IGNORE INTO time_entries
        (source_key, project_id, conversation_id, source, started_at, ended_at, day, backfilled)
      VALUES (?, ?, ?, 'agent', ?, ?, ?, 0)
    `);
    const write = this.db.transaction(() => {
      for (const row of events) {
        let payload: { startedAt?: string; completedAt?: string };
        try {
          payload = JSON.parse(row.payload);
        } catch {
          continue;
        }
        const span = agentSpan(payload.startedAt, payload.completedAt);
        if (!span) continue;
        insert.run(
          `agent:${row.conversation_id}:${new Date(span.start).toISOString()}`,
          row.project_id,
          row.conversation_id,
          new Date(span.start).toISOString(),
          new Date(span.end).toISOString(),
          localDay(new Date(span.start)),
        );
      }
      this.setSetting(SYNC_WATERMARK_KEY, String(Math.max(highest, Number(events[events.length - 1]!.id))));
    });
    write();
  }

  /**
   * Reprise de l'historique, une seule fois. L'horloge agent se reconstruit
   * exactement depuis les tours ; la présence n'existait qu'en totaux
   * journaliers sans intervalles, donc on la répartit entre les projets au
   * prorata des tours joués ce jour-là, puis on l'étale sur la journée. C'est
   * approximatif et c'est dit tel quel dans l'UI.
   */
  backfill(): { presenceMs: number; days: number } | null {
    if (this.setting(BACKFILL_KEY)) return null;
    this.syncAgentSegments();
    const legacy = this.db.query(
      "SELECT day, active_ms FROM gamification_activity ORDER BY day",
    ).all() as Array<{ day: string; active_ms: number | bigint }>;
    const insert = this.db.query(`
      INSERT OR IGNORE INTO time_entries
        (source_key, project_id, conversation_id, source, started_at, ended_at, day, backfilled)
      VALUES (?, ?, NULL, 'presence', ?, ?, ?, 1)
    `);
    let presenceMs = 0;
    let days = 0;
    const run = this.db.transaction(() => {
      for (const entry of legacy) {
        const activeMs = Number(entry.active_ms);
        if (activeMs <= 0) continue;
        const weights = this.db.query(`
          SELECT project_id, SUM(strftime('%s', ended_at) - strftime('%s', started_at)) AS weight
          FROM time_entries
          WHERE source = 'agent' AND day = ?
          GROUP BY project_id
        `).all(entry.day) as Array<{ project_id: string; weight: number | bigint }>;
        const totalWeight = weights.reduce((sum, row) => sum + Number(row.weight), 0);
        if (totalWeight <= 0) continue;
        days += 1;
        // Une seule tranche par projet et par jour, posée à partir de 9 h :
        // la position dans la journée est inconnue, seul le volume compte.
        let cursor = Date.parse(`${entry.day}T09:00:00`);
        for (const row of weights) {
          const share = Math.round(activeMs * (Number(row.weight) / totalWeight));
          if (share <= 0) continue;
          const start = new Date(cursor).toISOString();
          const end = new Date(cursor + share).toISOString();
          insert.run(`backfill:${entry.day}:${row.project_id}`, row.project_id, start, end, entry.day);
          cursor += share;
          presenceMs += share;
        }
      }
      this.setSetting(BACKFILL_KEY, new Date().toISOString());
    });
    run();
    return { presenceMs, days };
  }

  private setting(key: string): string | null {
    const row = this.db.query("SELECT value FROM settings WHERE key = ?")
      .get(key) as { value: string } | null;
    return row?.value ?? null;
  }

  private setSetting(key: string, value: string): void {
    this.db.query(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(key, value);
  }
}

function toSpan(row: { started_at: string; ended_at: string }): Span {
  return { start: Date.parse(row.started_at), end: Date.parse(row.ended_at) };
}

function agentSpan(startedAt?: string, completedAt?: string): Span | null {
  if (!startedAt || !completedAt) return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { start, end: Math.min(end, start + MAX_AGENT_SEGMENT_MS) };
}

export { LEVEL_MS, MILESTONE_HOURS, MAX_PRESENCE_SLICE_MS };
