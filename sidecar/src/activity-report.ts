import type { Database } from "bun:sqlite";
import { isProvider, type Provider, type StoredEvent } from "./events";
import type { DebriefGenerator } from "./debriefs";
import type { ChangelogStore } from "./stores/changelog";
import type { ConversationStore } from "./stores/conversations";
import type { PresetStore } from "./stores/presets";
import type { ProblemStore } from "./stores/problems";
import type { ProjectStore } from "./stores/projects";
import type { TicketStore } from "./stores/tickets";
import type { TodoItem, TodoStore } from "./stores/todos";
import type { TodoService } from "./todos";
import { localDay, type TimeTrackingService } from "./time-tracking";
import { projectCwd } from "./workspace";
import {
  ActivityStore,
  type ActivityEvidenceKind,
  type ActivityMotif,
  type ActivityReport,
  type ActivityReportCommit,
  type ActivityReportConversation,
  type ActivityReportMergeRequest,
  type ActivityReportProject,
  type ActivityReportRetro,
  type ActivityReportSummary,
  type ActivityReportTicket,
  type ActivityReportTicketReady,
  type ActivityReportTodo,
  type ActivityReportTopic,
  type ActivityCalendarDay,
  type ActivityState,
} from "./stores/activity";
import {
  applyRetroOperations,
  knownRefsFor,
  parseRetroOperations,
  retroPrompt,
  type RetroChanges,
} from "./activity-retro";

/** Bornes de la synthèse bon marché des sujets : jamais un vrai tour. */
const TOPIC_USER_MESSAGE_MAX = 600;
const TOPIC_USER_MESSAGES_PER_CONVERSATION = 8;
const TOPIC_AGENT_MESSAGE_MAX = 400;
const TOPIC_TITLE_MAX = 90;
const TOPIC_DETAIL_MAX = 280;
const TOPICS_MAX = 10;
const SUMMARY_MAX = 600;
/** Semaines complètes affichées par le calendrier, semaine en cours comprise. */
export const CALENDAR_WEEKS = 53;

/** Statuts ClickUp qui valent « prêt pour la production », comparés en minuscules. */
export const READY_STATUS_PATTERN = /ready\s*(for|to)\s*prod/i;

export type CheapJsonGenerator = (prompt: string, cwd: string) => Promise<unknown>;

export interface DayWindow {
  day: string;
  startIso: string;
  endIso: string;
  startMs: number;
  endMs: number;
}

export interface JournalConversation extends ActivityReportConversation {
  projectId: string;
  summary: string;
  events: StoredEvent[];
}

export interface JournalProject extends Omit<ActivityReportProject, "topics" | "topicsSource"> {
  /** Répertoire de la passe : celui du projet, le travail n'appartient à aucune conversation. */
  cwd: string;
  conversations: JournalConversation[];
}

/** Fenêtre locale d'un jour `AAAA-MM-JJ`, exprimée en UTC pour les requêtes. */
export function dayWindow(day: string): DayWindow {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("jour invalide");
  const start = new Date(`${day}T00:00:00`);
  if (Number.isNaN(start.getTime()) || localDay(start) !== day) throw new Error("jour invalide");
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return {
    day,
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    startMs: start.getTime(),
    endMs: end.getTime(),
  };
}

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export function authoredLineTotals(commits: Array<{
  linesAdded: number | null;
  linesRemoved: number | null;
  isMerge?: boolean;
}>): { linesAdded: number; linesRemoved: number } {
  return commits.reduce<{ linesAdded: number; linesRemoved: number }>((sum, commit) => {
    if (commit.isMerge) return sum;
    return {
      linesAdded: sum.linesAdded + (commit.linesAdded ?? 0),
      linesRemoved: sum.linesRemoved + (commit.linesRemoved ?? 0),
    };
  }, { linesAdded: 0, linesRemoved: 0 });
}

export class ActivityJournal {
  constructor(
    private db: Database,
    private projects: ProjectStore,
    private changelog: ChangelogStore,
    private time: TimeTrackingService,
    private tickets: TicketStore,
    private todos: TodoStore,
  ) {}

  /** Journée sans présence, sans tour, sans commit : aucun rapport à produire. */
  hasActivity(day: string): boolean {
    return this.build(day).length > 0;
  }

  /**
   * Agrégation déterministe du jour, projet par projet. Un projet apparaît dès
   * qu'il a une minute de présence, un tour, un commit ou une tâche terminée.
   */
  build(day: string): JournalProject[] {
    const window = dayWindow(day);
    const totals = this.time.dayTotals(day);
    const conversationsByProject = this.conversationsOfDay(window, totals.conversations);
    const out: JournalProject[] = [];
    for (const project of this.projects.list()) {
      const hours = totals.projects[project.id] ?? { userMs: 0, agentMs: 0 };
      const conversations = conversationsByProject.get(project.id) ?? [];
      const commits = this.commitsOfDay(project.id, window);
      const todosDone = this.todosDoneOfDay(project.id, window);
      const mergeRequests = this.mergeRequestsOfDay(project.id, window);
      const ticketsReady = this.ticketsReadyOfDay(project.id, window);
      if (hours.userMs === 0 && hours.agentMs === 0 && conversations.length === 0 && commits.length === 0 && todosDone.length === 0
        && mergeRequests.length === 0 && ticketsReady.length === 0) continue;
      const tickets = this.ticketsTouched(project.id, conversations, commits, todosDone, mergeRequests, ticketsReady);
      out.push({
        projectId: project.id,
        projectName: project.name,
        cwd: projectCwd(project),
        userMs: hours.userMs,
        agentMs: hours.agentMs,
        conversations,
        commits,
        unlinkedCommitCount: commits.filter((commit) => commit.conversationId === null).length,
        ...authoredLineTotals(commits),
        tickets,
        mergeRequests,
        ticketsReady,
        todosDone,
      });
    }
    return out.sort((left, right) => right.userMs - left.userMs || right.commits.length - left.commits.length);
  }

  private conversationsOfDay(
    window: DayWindow,
    hours: Record<string, { userMs: number; agentMs: number }>,
  ): Map<string, JournalConversation[]> {
    const rows = this.db.query(`
      SELECT e.conversation_id AS id, c.project_id, c.title, c.summary, c.ticket_id, t.key AS ticket_key,
             COALESCE((SELECT MIN(f.created_at) FROM events f WHERE f.conversation_id = c.id), c.created_at) AS started_at,
             SUM(CASE WHEN json_extract(e.payload, '$.type') = 'user-message' THEN 1 ELSE 0 END) AS turns
      FROM events e
      JOIN conversations c ON c.id = e.conversation_id
      LEFT JOIN tickets t ON t.id = c.ticket_id
      WHERE e.created_at >= ? AND e.created_at < ?
        AND json_valid(e.payload)
        AND json_extract(e.payload, '$.type') IN ('user-message', 'text-final')
        AND c.deleted_at IS NULL
      GROUP BY e.conversation_id
      ORDER BY MIN(e.id)
    `).all(window.startIso, window.endIso) as Array<{
      id: string; project_id: string; title: string; summary: string; ticket_id: string | null;
      ticket_key: string | null; started_at: string; turns: number | bigint;
    }>;
    const byProject = new Map<string, JournalConversation[]>();
    for (const row of rows) {
      const events = this.eventsOfDay(row.id, window);
      const list = byProject.get(row.project_id) ?? [];
      list.push({
        id: row.id,
        projectId: row.project_id,
        title: row.title,
        summary: row.summary,
        ticketId: row.ticket_id,
        ticketKey: row.ticket_key,
        startedDay: localDay(new Date(row.started_at)),
        userMs: hours[row.id]?.userMs ?? 0,
        agentMs: hours[row.id]?.agentMs ?? 0,
        turns: Number(row.turns),
        events,
      });
      byProject.set(row.project_id, list);
    }
    return byProject;
  }

  private eventsOfDay(conversationId: string, window: DayWindow): StoredEvent[] {
    const rows = this.db.query(`
      SELECT id, payload FROM events
      WHERE conversation_id = ? AND created_at >= ? AND created_at < ?
      ORDER BY id
    `).all(conversationId, window.startIso, window.endIso) as Array<{ id: number | bigint; payload: string }>;
    const events: StoredEvent[] = [];
    for (const row of rows) {
      try {
        events.push({ ...JSON.parse(row.payload), id: Number(row.id) });
      } catch {
        continue;
      }
    }
    return events;
  }

  private commitsOfDay(projectId: string, window: DayWindow): ActivityReportCommit[] {
    const entries = this.changelog.listBetween(projectId, window.startIso, window.endIso);
    if (entries.length === 0) return [];
    const links = this.db.query(`
      SELECT commit_sha, conversation_id FROM commit_links
      WHERE project_id = ? AND commit_sha IN (${entries.map(() => "?").join(", ")})
    `).all(projectId, ...entries.map((entry) => entry.commit_sha)) as Array<{ commit_sha: string; conversation_id: string }>;
    const linked = new Map(links.map((link) => [link.commit_sha, link.conversation_id]));
    return entries.map((entry) => ({
      sha: entry.commit_sha,
      repositoryPath: entry.repository_path,
      branch: entry.branch,
      subject: entry.subject,
      productMessage: entry.product_message,
      linesAdded: entry.lines_added,
      linesRemoved: entry.lines_removed,
      committedAt: entry.committed_at,
      conversationId: linked.get(entry.commit_sha) ?? null,
      isMerge: Boolean(entry.is_merge),
    }));
  }

  private todosDoneOfDay(projectId: string, window: DayWindow): ActivityReportTodo[] {
    return this.todos.list(projectId)
      .filter((item) => item.status === "done")
      .filter((item) => {
        const at = Date.parse(item.updated_at);
        return at >= window.startMs && at < window.endMs;
      })
      .map((item) => ({ id: item.id, title: item.title, ticketId: item.ticket_id }));
  }

  /**
   * MR ouvertes ce jour par l'utilisateur GitLab de l'intégration. Une MR
   * n'est connue que si la relève l'a vue ouverte : celle créée et fusionnée
   * entre deux relèves manque, et les MR relevées avant l'ajout de la date de
   * création n'ont pas de `createdAt`, donc restent absentes.
   */
  private mergeRequestsOfDay(projectId: string, window: DayWindow): ActivityReportMergeRequest[] {
    return this.mergeRequestsBetween(projectId, window.startMs, window.endMs);
  }

  /** MR ouvertes par moi dont la création tombe dans [startMs, endMs), triées par date. */
  mergeRequestsBetween(projectId: string, startMs: number, endMs: number): ActivityReportMergeRequest[] {
    const me = this.integrationSnapshot(projectId, "gitlab")?.username;
    if (typeof me !== "string" || !me) return [];
    const rows = this.db.query(`
      SELECT r.ref, r.payload_json, t.key
      FROM ticket_refs r JOIN tickets t ON t.id = r.ticket_id
      WHERE t.project_id = ? AND r.kind = 'mr'
    `).all(projectId) as Array<{ ref: string; payload_json: string; key: string }>;
    const out: ActivityReportMergeRequest[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.ref)) continue;
      let payload: Record<string, unknown>;
      try { payload = JSON.parse(row.payload_json) as Record<string, unknown>; } catch { continue; }
      if (payload.author !== me || typeof payload.createdAt !== "string") continue;
      const createdMs = Date.parse(payload.createdAt);
      if (!(createdMs >= startMs && createdMs < endMs)) continue;
      seen.add(row.ref);
      out.push({
        ref: row.ref,
        iid: Number(payload.iid ?? 0),
        project: String(payload.project ?? ""),
        title: String(payload.title ?? ""),
        url: String(payload.url ?? ""),
        state: String(payload.state ?? ""),
        ticketKey: row.key,
        createdAt: new Date(createdMs).toISOString(),
      });
    }
    return out.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  /** Un ticket compte une fois même s'il est repassé plusieurs fois par le statut dans la journée. */
  private ticketsReadyOfDay(projectId: string, window: DayWindow): ActivityReportTicketReady[] {
    const out = new Map<string, ActivityReportTicketReady>();
    for (const change of this.tickets.statusChangesBetween(projectId, window.startIso, window.endIso)) {
      if (!READY_STATUS_PATTERN.test(change.to_status) || READY_STATUS_PATTERN.test(change.from_status)) continue;
      if (out.has(change.ticket_id)) continue;
      const ticket = this.tickets.get(change.ticket_id);
      if (!ticket) continue;
      out.set(change.ticket_id, {
        ticketId: ticket.id,
        key: ticket.key,
        title: ticket.title,
        externalUrl: this.ticketUrl(projectId, ticket.key, ticket.external_url),
        toStatus: change.to_status,
        changedAt: change.changed_at,
      });
    }
    return [...out.values()];
  }

  private ticketsTouched(
    projectId: string,
    conversations: JournalConversation[],
    commits: ActivityReportCommit[],
    todos: ActivityReportTodo[],
    mergeRequests: ActivityReportMergeRequest[],
    ready: ActivityReportTicketReady[],
  ): ActivityReportTicket[] {
    const ids = new Set<string>();
    for (const conversation of conversations) if (conversation.ticketId) ids.add(conversation.ticketId);
    for (const todo of todos) if (todo.ticketId) ids.add(todo.ticketId);
    for (const item of ready) ids.add(item.ticketId);
    const known = this.tickets.listByProject(projectId);
    const branches = commits.map((commit) => commit.branch.toLowerCase());
    const mrKeys = new Set(mergeRequests.map((item) => item.ticketKey.toLowerCase()));
    for (const ticket of known) {
      const key = ticket.key.toLowerCase();
      if (key && (mrKeys.has(key) || branches.some((branch) => branch.includes(key)))) ids.add(ticket.id);
    }
    const out: ActivityReportTicket[] = [];
    for (const id of ids) {
      const ticket = known.find((item) => item.id === id) ?? this.tickets.get(id);
      if (ticket) out.push({ id: ticket.id, key: ticket.key, title: ticket.title, externalUrl: this.ticketUrl(projectId, ticket.key, ticket.external_url) });
    }
    return out.sort((left, right) => left.key.localeCompare(right.key));
  }

  /**
   * Un ticket connu seulement par Git n'a pas d'URL ; ClickUp résout les
   * identifiants personnalisés sous `/t/<équipe>/<clé>`, ce qui suffit quand
   * le projet a une intégration ClickUp.
   */
  private ticketUrl(projectId: string, key: string, externalUrl: string | null): string | null {
    if (externalUrl) return externalUrl;
    const teamId = this.integrationConfig(projectId, "clickup")?.teamId;
    if (typeof teamId !== "string" || !teamId || !/^[A-Z]+-\d+$/.test(key)) return null;
    return `https://app.clickup.com/t/${teamId}/${key}`;
  }

  private integrationConfig(projectId: string, type: string): Record<string, unknown> | null {
    return this.integrationColumn(projectId, type, "config_json");
  }

  private integrationSnapshot(projectId: string, type: string): Record<string, unknown> | null {
    return this.integrationColumn(projectId, type, "snapshot_json");
  }

  private integrationColumn(projectId: string, type: string, column: "config_json" | "snapshot_json"): Record<string, unknown> | null {
    const row = this.db.query(`SELECT ${column} AS value FROM project_integrations WHERE project_id = ? AND type = ?`)
      .get(projectId, type) as { value: string | null } | null;
    if (!row?.value) return null;
    try { return JSON.parse(row.value) as Record<string, unknown>; } catch { return null; }
  }
}

export function summaryPrompt(day: string, projects: ActivityReportProject[]): string {
  const material = projects.map((project) => ({
    project: project.projectName,
    presenceMinutes: Math.round(project.userMs / 60_000),
    commits: project.commits.length,
    mergeRequests: project.mergeRequests.map((item) => item.title),
    ticketsReady: project.ticketsReady.map((item) => `${item.key} ${item.title}`),
    topics: project.topics.map((topic) => `${topic.title} — ${topic.detail}`),
  }));
  return [
    `Tu résumes la journée du ${day} d'un développeur, tous projets confondus, pour qu'il la relise d'un coup d'œil.`,
    "Réponds UNIQUEMENT par un objet JSON, sans texte autour, sans bloc de code :",
    '{"summary": "..."}',
    "",
    `- summary : deux ou trois phrases en français (${SUMMARY_MAX} caractères maximum), ton de constat, au passé composé.`,
    "- Commence par ce qui a occupé le plus de temps, nomme les tickets par leur clé, termine par ce qui reste ouvert si c'est visible.",
    "- Aucune durée (ni heures ni minutes) et aucun nombre de lignes ou de commits : ces chiffres sont déjà affichés à côté.",
    "",
    `JOURNÉE : ${JSON.stringify(material)}`,
  ].join("\n");
}

export function parseSummary(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const raw = (payload as { summary?: unknown }).summary;
  if (typeof raw !== "string" || !raw.trim()) return null;
  return clamp(raw.trim().replace(/\s+/g, " "), SUMMARY_MAX);
}

export function topicsPrompt(project: JournalProject): string {
  const material = project.conversations.map((conversation) => {
    const users = conversation.events
      .filter((event): event is StoredEvent & { type: "user-message"; text: string } => event.type === "user-message")
      .slice(0, TOPIC_USER_MESSAGES_PER_CONVERSATION)
      .map((event) => clamp(event.text, TOPIC_USER_MESSAGE_MAX));
    const lastAgent = [...conversation.events].reverse().find((event) => event.type === "text-final");
    return {
      id: conversation.id,
      title: conversation.title,
      summary: clamp(conversation.summary, 400),
      userMessages: users,
      lastAgentMessage: lastAgent && lastAgent.type === "text-final" ? clamp(lastAgent.text, TOPIC_AGENT_MESSAGE_MAX) : null,
    };
  });
  return [
    `Tu rédiges le journal de la journée d'un développeur sur le projet « ${project.projectName} » à partir de ses conversations avec des agents de code.`,
    "Regroupe les conversations par sujet réellement traité (un sujet peut couvrir plusieurs conversations, une conversation ne va que dans un sujet).",
    "Réponds UNIQUEMENT par un objet JSON, sans texte autour, sans bloc de code :",
    '{"topics": [{"title": "...", "detail": "...", "conversationIds": ["..."]}]}',
    "",
    `- title : ${TOPIC_TITLE_MAX} caractères maximum, en français, sans ponctuation finale. Le TRAVAIL fait, pas la formulation de la demande.`,
    `- detail : une phrase (${TOPIC_DETAIL_MAX} caractères maximum) : ce qui a été obtenu ou où ça en est. Ton de constat, pas d'appréciation.`,
    "- conversationIds : identifiants exacts des conversations du sujet, pris dans la liste ci-dessous.",
    `- ${TOPICS_MAX} sujets maximum, du plus important au moins important.`,
    "",
    `CONVERSATIONS DU JOUR : ${JSON.stringify(material)}`,
  ].join("\n");
}

/** Garde les sujets dont les conversations existent ; une conversation orpheline devient son propre sujet. */
export function parseTopics(payload: unknown, project: JournalProject): ActivityReportTopic[] | null {
  if (!payload || typeof payload !== "object") return null;
  const raw = (payload as { topics?: unknown }).topics;
  if (!Array.isArray(raw)) return null;
  const known = new Set(project.conversations.map((conversation) => conversation.id));
  const assigned = new Set<string>();
  const topics: ActivityReportTopic[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const title = String((item as { title?: unknown }).title ?? "").trim();
    const detail = String((item as { detail?: unknown }).detail ?? "").trim();
    const ids = (item as { conversationIds?: unknown }).conversationIds;
    if (!title || !Array.isArray(ids)) continue;
    const conversationIds = ids
      .filter((id): id is string => typeof id === "string" && known.has(id) && !assigned.has(id));
    if (conversationIds.length === 0) continue;
    for (const id of conversationIds) assigned.add(id);
    topics.push({ title: clamp(title, TOPIC_TITLE_MAX), detail: clamp(detail, TOPIC_DETAIL_MAX), conversationIds });
    if (topics.length >= TOPICS_MAX) break;
  }
  if (topics.length === 0) return null;
  for (const conversation of project.conversations) {
    if (!assigned.has(conversation.id)) topics.push(topicFromConversation(conversation));
  }
  return topics;
}

function topicFromConversation(conversation: JournalConversation): ActivityReportTopic {
  return {
    title: clamp(conversation.title, TOPIC_TITLE_MAX),
    detail: clamp(conversation.summary, TOPIC_DETAIL_MAX),
    conversationIds: [conversation.id],
  };
}

export function fallbackTopics(project: JournalProject): ActivityReportTopic[] {
  return project.conversations.map(topicFromConversation);
}

export function toReportProject(
  project: JournalProject,
  topics: ActivityReportTopic[] | null,
): ActivityReportProject {
  const { cwd: _cwd, conversations, ...rest } = project;
  return {
    ...rest,
    topics: topics ?? fallbackTopics(project),
    topicsSource: topics ? "model" : "titles",
    conversations: conversations.map(({ projectId: _p, summary: _s, events: _e, ...conversation }) => conversation),
  };
}

export function assembleReport(
  day: string,
  generatedAt: string,
  projects: ActivityReportProject[],
  retro: ActivityReportRetro,
  summary: string | null = null,
): ActivityReport {
  return {
    day,
    generatedAt,
    summary,
    projects,
    totals: {
      userMs: projects.reduce((sum, project) => sum + project.userMs, 0),
      agentMs: projects.reduce((sum, project) => sum + project.agentMs, 0),
      commits: projects.reduce((sum, project) => sum + project.commits.length, 0),
      mergeRequests: projects.reduce((sum, project) => sum + project.mergeRequests.length, 0),
      ticketsReady: projects.reduce((sum, project) => sum + project.ticketsReady.length, 0),
      linesAdded: projects.reduce((sum, project) => sum + project.linesAdded, 0),
      linesRemoved: projects.reduce((sum, project) => sum + project.linesRemoved, 0),
      conversations: projects.reduce((sum, project) => sum + project.conversations.length, 0),
    },
    retro,
  };
}

/**
 * Un rapport sauvé avant que le changelog ait relevé les +/− de ses commits
 * garde des lignes nulles : on les reprend du changelog à la lecture, ainsi que
 * les champs ajoutés après coup, sans réécrire le rapport. Les fusions restent
 * visibles ligne à ligne mais sortent des totaux.
 */
export function hydrateReport(report: ActivityReport, changelog: ChangelogStore): ActivityReport {
  const window = dayWindow(report.day);
  const projects = report.projects.map((project) => {
    const base: ActivityReportProject = { ...project, mergeRequests: project.mergeRequests ?? [], ticketsReady: project.ticketsReady ?? [] };
    const stats = new Map(changelog.listBetween(base.projectId, window.startIso, window.endIso)
      .map((entry) => [entry.commit_sha, entry]));
    const commits = base.commits.map((commit) => {
      const entry = stats.get(commit.sha);
      return {
        ...commit,
        linesAdded: commit.linesAdded ?? entry?.lines_added ?? null,
        linesRemoved: commit.linesRemoved ?? entry?.lines_removed ?? null,
        isMerge: commit.isMerge || Boolean(entry?.is_merge),
      };
    });
    return { ...base, commits, ...authoredLineTotals(commits) };
  });
  return assembleReport(report.day, report.generatedAt, projects, report.retro, report.summary ?? null);
}

export { ActivityStore };

export interface StrongModelConfig {
  provider: Provider;
  model: string;
  effort: string;
  speed: "standard" | "fast";
}

export const DEFAULT_ACTIVITY_MODEL: StrongModelConfig = {
  provider: "codex", model: "gpt-6-luna", effort: "high", speed: "standard",
};

export interface ActivityRetroPayload {
  state: ActivityState;
  cumulative: {
    firstDay: string | null;
    activeDays: number;
    userMs: number;
    agentMs: number;
    commits: number;
    linesAdded: number;
    linesRemoved: number;
    projects: number;
  };
  trends: Array<{ days: number; userMs: number; agentMs: number; activeDays: number; commits: number; linesAdded: number; linesRemoved: number }>;
  motifs: ActivityMotif[];
}

export interface ActivityRunState {
  running: boolean;
  runningDay: string | null;
  state: ActivityState;
}

export class ActivityReportService {
  private runningDay: string | null = null;

  constructor(
    private store: ActivityStore,
    private journal: ActivityJournal,
    private projects: ProjectStore,
    private problems: ProblemStore,
    private todos: TodoService,
    private conversations: ConversationStore,
    private presets: PresetStore,
    private time: TimeTrackingService,
    private changelog: ChangelogStore,
    private cheap: CheapJsonGenerator,
    private strong: DebriefGenerator,
    private strongConfig: () => StrongModelConfig = () => DEFAULT_ACTIVITY_MODEL,
    private now: () => Date = () => new Date(),
    private prepare: () => Promise<void> = async () => {},
  ) {}

  runState(): ActivityRunState {
    return { running: this.runningDay !== null, runningDay: this.runningDay, state: this.store.state() };
  }

  days(): ActivityReportSummary[] {
    return this.store.days();
  }

  report(day: string): ActivityReport | null {
    const stored = this.store.report(day);
    return stored ? hydrateReport(stored, this.changelog) : null;
  }

  /**
   * Calendrier de chaleur : un jour par case du lundi d'il y a
   * CALENDAR_WEEKS − 1 semaines jusqu'à aujourd'hui, commits, lignes et MR
   * ouvertes par projet, présence depuis les entrées de temps.
   */
  calendar(): { from: string; to: string; days: ActivityCalendarDay[] } {
    const today = new Date(this.now());
    today.setHours(0, 0, 0, 0);
    const start = new Date(today);
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7) - (CALENDAR_WEEKS - 1) * 7);
    const from = localDay(start);
    const to = localDay(today);
    const names = new Map(this.projects.list().map((project) => [project.id, project.name]));
    const commits = this.changelog.dailyTotals(from, to);
    const presence = this.time.dailyPresence(from, to);
    const reports = new Set(this.store.days().map((item) => item.day));
    const endMs = today.getTime() + 86_400_000;
    const mergeRequests = new Map<string, number>();
    for (const projectId of names.keys()) {
      for (const mr of this.journal.mergeRequestsBetween(projectId, start.getTime(), endMs)) {
        const key = `${localDay(new Date(mr.createdAt))}:${projectId}`;
        mergeRequests.set(key, (mergeRequests.get(key) ?? 0) + 1);
      }
    }
    const days: ActivityCalendarDay[] = [];
    for (const cursor = new Date(start); cursor <= today; cursor.setDate(cursor.getDate() + 1)) {
      const day = localDay(cursor);
      const rows = commits.filter((row) => row.day === day);
      const projectIds = new Set(rows.map((row) => row.projectId));
      for (const key of mergeRequests.keys()) if (key.startsWith(`${day}:`)) projectIds.add(key.slice(day.length + 1));
      const projects = [...projectIds].map((projectId) => {
        const row = rows.find((item) => item.projectId === projectId);
        return {
          projectId,
          projectName: names.get(projectId) ?? projectId,
          commits: row?.commits ?? 0,
          linesAdded: row?.linesAdded ?? 0,
          linesRemoved: row?.linesRemoved ?? 0,
          mergeRequests: mergeRequests.get(`${day}:${projectId}`) ?? 0,
        };
      });
      days.push({
        day,
        commits: projects.reduce((sum, row) => sum + row.commits, 0),
        linesAdded: projects.reduce((sum, row) => sum + row.linesAdded, 0),
        linesRemoved: projects.reduce((sum, row) => sum + row.linesRemoved, 0),
        mergeRequests: projects.reduce((sum, row) => sum + row.mergeRequests, 0),
        userMs: presence[day] ?? 0,
        hasReport: reports.has(day),
        projects,
      });
    }
    return { from, to, days };
  }

  /**
   * Passe complète d'un jour : journal déterministe, sujets bon marché, puis
   * recul projet par projet. Le journal est sauvé même si le recul échoue ;
   * un jour sans activité ne laisse aucun rapport. Une seule passe à la fois.
   */
  async generate(day: string): Promise<ActivityReport | null> {
    dayWindow(day);
    if (this.runningDay !== null) throw new ActivityBusyError(`passe déjà en cours pour le ${this.runningDay}`);
    this.runningDay = day;
    try {
      await this.prepare();
      const journal = this.journal.build(day);
      if (journal.length === 0) {
        this.store.deleteReport(day);
        return null;
      }
      const projects: ActivityReportProject[] = [];
      const retro: ActivityReportRetro = { created: [], updated: [], stabilized: [], returned: [], error: null };
      const errors: string[] = [];
      for (const project of journal) {
        let topics: ActivityReportTopic[] | null = null;
        if (project.conversations.length > 0) {
          try {
            topics = parseTopics(await this.cheap(topicsPrompt(project), project.cwd), project);
          } catch (error) {
            console.error(`[activité] sujets de ${project.projectName} impossibles`, error);
          }
        }
        projects.push(toReportProject(project, topics));
        try {
          const changes = await this.retroPass(project, day);
          retro.created.push(...changes.created);
          retro.updated.push(...changes.updated);
          retro.stabilized.push(...changes.stabilized);
          retro.returned.push(...changes.returned);
        } catch (error) {
          errors.push(`${project.projectName} : ${error instanceof Error ? error.message : "recul impossible"}`);
        }
      }
      retro.error = errors.length > 0 ? errors.join(" · ") : null;
      let summary: string | null = null;
      try {
        summary = parseSummary(await this.cheap(summaryPrompt(day, projects), journal[0]!.cwd));
      } catch (error) {
        console.error("[activité] résumé du jour impossible", error);
      }
      const generatedAt = this.now().toISOString();
      const report = assembleReport(day, generatedAt, projects, retro, summary);
      this.store.saveReport(report);
      this.store.markProcessed(day, generatedAt);
      if (retro.error) this.store.setState({ last_error: retro.error });
      return report;
    } catch (error) {
      this.store.setState({ last_run_at: this.now().toISOString(), last_error: error instanceof Error ? error.message : "passe impossible" });
      throw error;
    } finally {
      this.runningDay = null;
    }
  }

  private async retroPass(project: JournalProject, day: string): Promise<RetroChanges> {
    const motifs = this.store.listMotifs({ projectId: project.projectId });
    const problems = this.problems.listProject(project.projectId, "open").problems;
    const config = this.strongConfig();
    const raw = await this.strong({
      cwd: project.cwd,
      provider: config.provider,
      model: config.model,
      effort: config.effort,
      speed: config.speed,
      prompt: retroPrompt(project, day, motifs, problems),
    });
    const operations = parseRetroOperations(raw, knownRefsFor(project, problems), motifs);
    return applyRetroOperations(this.store, project.projectId, day, operations, this.now().toISOString());
  }

  /** Bilan cumulé et tendances calculés par SQL à la lecture ; les motifs viennent de l'état entretenu. */
  retro(): ActivityRetroPayload {
    const state = this.store.state();
    const snapshot = this.time.snapshot();
    const totals = this.changelog.totals();
    const nowMs = this.now().getTime();
    const trends = [7, 30].map((days) => {
      const start = new Date(nowMs);
      start.setHours(0, 0, 0, 0);
      start.setDate(start.getDate() - (days - 1));
      const end = new Date(start);
      end.setDate(end.getDate() + days);
      const range = this.time.rangeTotals(start.getTime(), end.getTime());
      const commits = this.changelog.totals(undefined, start.toISOString(), end.toISOString());
      return { days, ...range, ...commits };
    });
    const firstEntry = this.time.activeDays()[0] ?? null;
    return {
      state,
      cumulative: {
        firstDay: firstEntry && (state.first_day === null || firstEntry < state.first_day) ? firstEntry : state.first_day,
        activeDays: snapshot.activeDays,
        userMs: snapshot.user.ms,
        agentMs: snapshot.agent.ms,
        commits: totals.commits,
        linesAdded: totals.linesAdded,
        linesRemoved: totals.linesRemoved,
        projects: snapshot.projectCount,
      },
      trends,
      motifs: this.store.listMotifs().filter((motif) => motif.status !== "dismissed" || motif.returned_at !== null),
    };
  }

  motif(id: string): ActivityMotif {
    const motif = this.store.motif(id);
    if (!motif) throw new ActivityNotFoundError("motif inconnu");
    return motif;
  }

  dismiss(id: string): ActivityMotif {
    const motif = this.motif(id);
    const now = this.now().toISOString();
    return this.store.updateMotif(motif.id, { status: "dismissed", dismissed_at: now, returned_at: null }, now);
  }

  /**
   * Crée une tâche en backlog dans le projet du motif, jamais en file : le
   * constat et les preuves forment le message. La configuration vient de
   * l'appelant (mémoire de lancement du projet), sinon du preset de tâches
   * du projet, puis de sa dernière conversation, puis du défaut.
   */
  async createTask(id: string, config?: Partial<StrongModelConfig> | null): Promise<{ motif: ActivityMotif; todo: TodoItem }> {
    const motif = this.motif(id);
    if (motif.todo_id && this.todos.store.get(motif.todo_id)) {
      return { motif, todo: this.todos.store.get(motif.todo_id)! };
    }
    const launch = this.launchConfig(motif.project_id, config);
    const tickets = motif.evidence.filter((item) => item.kind === "ticket");
    const todo = await this.todos.create(motif.project_id, {
      status: "backlog",
      title: motif.title,
      message: motifTaskMessage(motif),
      ticketId: tickets.length === 1 ? tickets[0]!.ref : null,
      provider: launch.provider,
      model: launch.model,
      effort: launch.effort,
      speed: launch.speed,
    });
    const now = this.now().toISOString();
    const updated = this.store.updateMotif(motif.id, { status: "handled", todo_id: todo.id }, now);
    return { motif: updated, todo };
  }

  private launchConfig(projectId: string, config?: Partial<StrongModelConfig> | null): StrongModelConfig {
    if (config && isProvider(config.provider) && typeof config.model === "string" && config.model.trim()) {
      return {
        provider: config.provider,
        model: config.model,
        effort: typeof config.effort === "string" ? config.effort : "medium",
        speed: config.speed === "fast" ? "fast" : "standard",
      };
    }
    const project = this.projects.get(projectId);
    const presetId = project?.default_todo_preset_id ?? project?.default_preset_id ?? null;
    const preset = presetId ? this.presets.get(presetId) : null;
    if (preset) {
      return { provider: preset.provider, model: preset.model, effort: preset.effort ?? "medium", speed: preset.speed ?? "standard" };
    }
    const latest = this.conversations.listByProject(projectId)[0];
    if (latest) {
      return { provider: latest.provider, model: latest.model, effort: latest.effort ?? "medium", speed: latest.speed ?? "standard" };
    }
    return DEFAULT_ACTIVITY_MODEL;
  }
}

export class ActivityBusyError extends Error {}
export class ActivityNotFoundError extends Error {}

const EVIDENCE_LABELS: Record<ActivityEvidenceKind, string> = {
  conversation: "Conversation",
  commit: "Commit",
  ticket: "Ticket",
  problem: "Problème",
};

export function motifTaskMessage(motif: ActivityMotif): string {
  return [
    motif.title,
    "",
    motif.statement,
    "",
    `Preuves relevées par le rapport d'activité (motif ${motif.id}) :`,
    ...motif.evidence.map((item) => `- ${EVIDENCE_LABELS[item.kind]} ${item.kind === "commit" ? item.ref.slice(0, 7) : item.ref} · ${item.label} (${item.day})`),
  ].join("\n");
}
