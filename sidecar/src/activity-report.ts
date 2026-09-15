import type { Database } from "bun:sqlite";
import type { StoredEvent } from "./events";
import type { ChangelogStore } from "./stores/changelog";
import type { ProjectStore } from "./stores/projects";
import type { TicketStore } from "./stores/tickets";
import type { TodoStore } from "./stores/todos";
import { localDay, type TimeTrackingService } from "./time-tracking";
import {
  ActivityStore,
  type ActivityReport,
  type ActivityReportCommit,
  type ActivityReportConversation,
  type ActivityReportProject,
  type ActivityReportRetro,
  type ActivityReportTicket,
  type ActivityReportTodo,
  type ActivityReportTopic,
} from "./stores/activity";

/** Bornes de la synthèse bon marché des sujets : jamais un vrai tour. */
const TOPIC_USER_MESSAGE_MAX = 600;
const TOPIC_USER_MESSAGES_PER_CONVERSATION = 8;
const TOPIC_AGENT_MESSAGE_MAX = 400;
const TOPIC_TITLE_MAX = 90;
const TOPIC_DETAIL_MAX = 280;
const TOPICS_MAX = 10;

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
  path: string;
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
      if (hours.userMs === 0 && hours.agentMs === 0 && conversations.length === 0 && commits.length === 0 && todosDone.length === 0) continue;
      const tickets = this.ticketsTouched(project.id, conversations, commits, todosDone);
      out.push({
        projectId: project.id,
        projectName: project.name,
        path: project.path,
        userMs: hours.userMs,
        agentMs: hours.agentMs,
        conversations,
        commits,
        unlinkedCommitCount: commits.filter((commit) => commit.conversationId === null).length,
        linesAdded: commits.reduce((sum, commit) => sum + (commit.linesAdded ?? 0), 0),
        linesRemoved: commits.reduce((sum, commit) => sum + (commit.linesRemoved ?? 0), 0),
        tickets,
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

  private ticketsTouched(
    projectId: string,
    conversations: JournalConversation[],
    commits: ActivityReportCommit[],
    todos: ActivityReportTodo[],
  ): ActivityReportTicket[] {
    const ids = new Set<string>();
    for (const conversation of conversations) if (conversation.ticketId) ids.add(conversation.ticketId);
    for (const todo of todos) if (todo.ticketId) ids.add(todo.ticketId);
    const known = this.tickets.listByProject(projectId);
    const branches = commits.map((commit) => commit.branch.toLowerCase());
    for (const ticket of known) {
      const key = ticket.key.toLowerCase();
      if (key && branches.some((branch) => branch.includes(key))) ids.add(ticket.id);
    }
    const out: ActivityReportTicket[] = [];
    for (const id of ids) {
      const ticket = known.find((item) => item.id === id) ?? this.tickets.get(id);
      if (ticket) out.push({ id: ticket.id, key: ticket.key, title: ticket.title, externalUrl: ticket.external_url });
    }
    return out.sort((left, right) => left.key.localeCompare(right.key));
  }
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
  const { path: _path, conversations, ...rest } = project;
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
): ActivityReport {
  return {
    day,
    generatedAt,
    projects,
    totals: {
      userMs: projects.reduce((sum, project) => sum + project.userMs, 0),
      agentMs: projects.reduce((sum, project) => sum + project.agentMs, 0),
      commits: projects.reduce((sum, project) => sum + project.commits.length, 0),
      linesAdded: projects.reduce((sum, project) => sum + project.linesAdded, 0),
      linesRemoved: projects.reduce((sum, project) => sum + project.linesRemoved, 0),
      conversations: projects.reduce((sum, project) => sum + project.conversations.length, 0),
    },
    retro,
  };
}

export { ActivityStore };
