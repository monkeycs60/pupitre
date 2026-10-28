import type { Database } from "bun:sqlite";
import { asksForDecision, type ConversationNudge, type NudgeAction } from "./conversation-nudges";
import { canonicalPath } from "./filesystem-path";
import type { FleetItem } from "./fleet";
import { readHead } from "./git-repositories";
import { contextForCwd, type ApplicationContext, type RunningApplication } from "./running-applications";
import type { SemanticSearchHit } from "./semantic-search";
import type { AttentionItem } from "./stores/attention-items";
import type { ConversationStore } from "./stores/conversations";
import type { ProjectStore } from "./stores/projects";
import { projectCwd } from "./workspace";

export type JarvisConversationStatus = "waiting" | "running" | "unread" | "idle" | "archived";

export interface JarvisHistoryEntry {
  role: "user" | "jarvis";
  text: string;
}

export interface JarvisContextInput {
  question: string;
  projectId: string | null;
  conversationId: string | null;
  history: JarvisHistoryEntry[];
}

export interface JarvisContextDeps {
  db: Database;
  projects: ProjectStore;
  conversations: ConversationStore;
  fleet: () => FleetItem[];
  nudges?: () => ConversationNudge[];
  attention?: () => AttentionItem[];
  actionHeadings?: () => string[];
  runningApplications: (contexts: ApplicationContext[]) => RunningApplication[];
}

export interface JarvisExcerpt {
  id: number;
  at: string;
  role: "user" | "agent";
  text: string;
  matched: boolean;
}

export type JarvisConversationTag = "current" | "waiting" | "running" | "match" | "unread" | "server" | "recent";

export interface JarvisConversationEntry {
  alias: string;
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  summary: string;
  status: JarvisConversationStatus;
  pinned: boolean;
  ticketKey: string | null;
  ticketUrl: string | null;
  branch: string | null;
  updatedAt: string;
  tags: JarvisConversationTag[];
  running: { since: string; activity: string } | null;
  waiting: { question: string; options: NudgeAction[] } | null;
  semanticReason: string | null;
  excerpts: JarvisExcerpt[];
}

export interface JarvisProjectEntry {
  alias: string;
  id: string;
  name: string;
  current: boolean;
}

export interface JarvisServerEntry {
  alias: string;
  url: string;
  port: number;
  name: string;
  process: string;
  projectId: string;
  projectName: string;
  workspace: string;
  branch: string | null;
  conversations: string[];
}

export interface JarvisTicketEntry {
  key: string;
  title: string;
  status: string;
  url: string | null;
  projectAlias: string;
}

export interface JarvisContext {
  now: Date;
  question: string;
  history: JarvisHistoryEntry[];
  currentProject: JarvisProjectEntry | null;
  currentConversation: JarvisConversationEntry | null;
  projects: JarvisProjectEntry[];
  conversations: JarvisConversationEntry[];
  servers: JarvisServerEntry[];
  tickets: JarvisTicketEntry[];
  totals: { running: number; waiting: number; unread: number };
}

export interface JarvisLiveState {
  running: Map<string, { since: string; activity: string }>;
  waiting: Map<string, { question: string; options: NudgeAction[] }>;
  unread: string[];
}

export function liveTotals(live: JarvisLiveState): JarvisContext["totals"] {
  return {
    running: live.running.size,
    waiting: live.waiting.size,
    unread: live.unread.filter((id) => !live.running.has(id) && !live.waiting.has(id)).length,
  };
}

export interface JarvisTextSearch {
  terms: string[];
  total: number;
  ranked: Array<{ id: string; score: number }>;
}

export interface JarvisServers {
  applications: RunningApplication[];
  linked: Map<string, string[]>;
}

export const MAX_CANDIDATES = 12;
const MAX_EXCERPTS = 8;
const MAX_MATCHED_EXCERPTS = 6;
const MAX_TERMS = 12;
const MAX_STATE_ENTRIES = 12;
const MAX_UNREAD_ENTRIES = 10;
const MAX_RECENT_ENTRIES = 6;
const MAX_LINKED_CONVERSATIONS = 3;
const UNREAD_SCAN = 30;
const RANKED_CONVERSATIONS = 40;
const RRF_K = 5;
const CURRENT_PROJECT_BOOST = 0.03;
const EXCERPT_CHARS = 220;
const QUESTION_CHARS = 400;
const TICKET_PATTERN = /\b([A-Za-z]{2,12})-(\d{1,7})\b/g;

const STOPWORDS = new Set(`
  a ai aie ainsi alors as au aucun aucune aujourd aupres aussi autre autres aux avais avait avant avec avoir avons avez
  bah beaucoup bien bon ca car ce ceci cela celle celles celui ceux ces cet cette chaque chez ci combien comme comment
  d dans de depuis des deja donc dont du elle elles en encore entre es est et etaient etait etc ete etre eu fais fait
  faire faites faut hier hui ici il ils j je jusqu l la le les leur leurs lui m ma mais me meme memes mes moi moins mon
  n ne ni non nos notre nous on ont ou oui par parce pas peu peut peux plus pour pourquoi pourrais pourrait puis qu
  quand que quel quelle quelles quels qui quoi s sa sans se ses si sinon soit son sont sous sur t ta te tes toi ton
  tous tout toute toutes tres tu un une uns va vais vas veut veux vers voila vos votre vous vu y demain semaine mois
  jour jours matin soir dernier derniere derniers dernieres recemment recent recente recentes maintenant actuellement
  rien quelque quelques chose choses truc trucs genre propos sujet
  the an of to in at for with is are was were be been what where who when how why which it its this that these those
  and or but not my me i you your we our do does did can could should would will about from by if then than there
  here all any some
  jarvis conversation conversations agent agents cherche chercher cherches trouve trouver trouves retrouve retrouver
  montre montrer affiche afficher ouvre ouvrir parle parler parles parlait discute discuter discutait dit dis dire
  disait attend attendent attends attente tourne tournent tourner lance lancer marche marchent projet projets
  question questions reponse reponses repond repondre reponds message messages envoie envoyer besoin stp svp merci
`.trim().split(/\s+/));

const SUFFIXES = [
  "issements", "issement", "ations", "ation", "ements", "ement", "ments", "ment",
  "euses", "euse", "eurs", "eur", "ives", "ive", "ees", "ee", "es", "er", "ez", "e", "s",
];

function plain(token: string): string {
  return token.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function stem(word: string): string {
  for (const suffix of SUFFIXES) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 4) return word.slice(0, -suffix.length);
  }
  return word.length >= 4 && word.endsWith("s") ? word.slice(0, -1) : word;
}

/** Expressions FTS5 tirées d'une question : clés de ticket en phrase exacte, mots pleins racinisés en préfixe. */
export function searchTerms(text: string): string[] {
  const terms: string[] = [];
  const add = (term: string) => {
    if (!terms.includes(term)) terms.push(term);
  };
  for (const match of text.matchAll(TICKET_PATTERN)) add(`"${plain(match[1]!)} ${match[2]}"`);
  const rest = text.replace(TICKET_PATTERN, " ").normalize("NFKC");
  for (const token of rest.match(/[\p{L}\p{N}_]+/gu) ?? []) {
    const word = plain(token);
    if (/^[A-Z]{2}$/.test(token)) {
      add(`"${word}"`);
      continue;
    }
    if (STOPWORDS.has(word)) continue;
    if (/\d/.test(word)) {
      if (word.length >= 2) add(`"${word}"`);
      continue;
    }
    if (word.length < 3) continue;
    add(`"${stem(word)}"*`);
  }
  return terms.slice(0, MAX_TERMS);
}

export function ticketKeysIn(text: string): string[] {
  return [...new Set([...text.matchAll(TICKET_PATTERN)].map((match) => `${match[1]!.toUpperCase()}-${match[2]}`))];
}

export function clipText(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Extrait de message débarrassé de la syntaxe Markdown qui le rend illisible en une ligne. */
function plainExcerpt(value: string, max: number): string {
  const text = value
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/(\|\s*:?-{3,}:?\s*)+\|?/g, " | ")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s*\|\s*/g, " · ")
    .replace(/·(\s*·)+/g, "·");
  return clipText(text.replace(/^[\s·]+|[\s·]+$/g, ""), max);
}

function tailText(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `…${text.slice(text.length - max + 1).trimStart()}` : text;
}

function joinText(title: string, body: string): string {
  return body.trim() ? `${title.trim()} — ${body.trim()}` : title.trim();
}

function toolHint(input: unknown): string {
  if (input === null || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  for (const key of ["command", "file_path", "path", "pattern", "url", "description"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return ` \`${clipText(value, 80)}\``;
  }
  return "";
}

function fleetActivity(item: FleetItem): string {
  if (item.kind === "subtask") return `sous-tâche « ${clipText(item.title, 60)} » (${item.lastEvent})`;
  return item.lastTool ? `${item.lastTool.toolName}${toolHint(item.lastTool.input)}` : item.lastEvent;
}

function worktreeRoots(raw: unknown, fallback: string | null): string[] {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (Array.isArray(parsed) && parsed.every((path) => typeof path === "string") && parsed.length > 0) return parsed;
  } catch {
    // Une valeur illisible retombe sur le worktree principal.
  }
  return fallback ? [fallback] : [];
}

interface ConversationRow {
  id: string;
  project_id: string;
  project_name: string;
  title: string;
  summary: string;
  archived: number;
  pinned: number;
  answered_turn: number;
  last_read_turn: number;
  updated_at: string;
  worktree_path: string | null;
  ticket_key: string | null;
  ticket_url: string | null;
}

export class JarvisContextBuilder {
  constructor(
    private readonly deps: JarvisContextDeps,
    private readonly input: JarvisContextInput,
    private readonly now = new Date(),
  ) {}

  liveState(): JarvisLiveState {
    const running = new Map<string, { since: string; activity: string }>();
    for (const item of this.deps.fleet()) {
      const known = running.get(item.conversationId);
      if (known) known.activity = `${known.activity} · ${fleetActivity(item)}`;
      else running.set(item.conversationId, { since: item.startedAt, activity: fleetActivity(item) });
    }

    const projects = new Set(this.deps.projects.list().map((project) => project.id));
    const waiting = new Map<string, { question: string; options: NudgeAction[] }>();
    for (const nudge of this.deps.nudges?.() ?? []) {
      if (!projects.has(nudge.project_id) || nudge.parked !== null || nudge.kind === "review") continue;
      if (running.has(nudge.conversation_id)) continue;
      waiting.set(nudge.conversation_id, { question: joinText(nudge.title, nudge.body), options: nudge.actions });
    }
    for (const item of this.deps.attention?.() ?? []) {
      if (item.target.kind !== "conversation" || !projects.has(item.project_id)) continue;
      const id = item.target.conversationId;
      if (running.has(id) || waiting.has(id)) continue;
      waiting.set(id, { question: joinText(item.title, item.body), options: [] });
    }

    const unread = this.deps.conversations.listUnread()
      .filter((conversation) => projects.has(conversation.project_id))
      .map((conversation) => conversation.id);
    const headings = (this.deps.actionHeadings?.() ?? []).map((heading) => heading.toUpperCase());
    for (const id of unread.slice(0, UNREAD_SCAN)) {
      if (running.has(id) || waiting.has(id)) continue;
      const status = this.deps.conversations.latestStatus(id);
      if (status?.state === "error") {
        waiting.set(id, {
          question: `Le dernier tour s'est arrêté en erreur : ${clipText(status.error ?? "erreur inconnue", 200)}`,
          options: [],
        });
        continue;
      }
      const answer = this.lastEvents(id, 1).find((message) => message.role === "agent");
      if (answer && asksForDecision(answer.text, headings)) {
        waiting.set(id, { question: tailText(answer.text, QUESTION_CHARS), options: [] });
      }
    }
    return { running, waiting, unread };
  }

  searchText(): JarvisTextSearch {
    const total = Number((this.deps.db.query(`
      SELECT COUNT(*) AS count FROM conversations c
      JOIN projects p ON p.id = c.project_id
      WHERE c.deleted_at IS NULL AND p.removed_at IS NULL
    `).get() as { count: number | bigint }).count);
    let terms = searchTerms(this.input.question);
    if (terms.length < 2) {
      const previous = this.input.history.findLast((entry) => entry.role === "user");
      if (previous) terms = [...new Set([...terms, ...searchTerms(previous.text)])].slice(0, MAX_TERMS);
    }
    if (terms.length === 0) return { terms, total, ranked: [] };

    const expression = terms.join(" OR ");
    const scores = new Map<string, number>();
    const rankings = [
      this.rank(expression, ["conversation", "debrief"], "8.0, 1.0"),
      this.rank(`body : (${expression})`, ["event"], "0.0, 1.0"),
    ];
    for (const ranking of rankings) {
      ranking.forEach((row, index) => {
        const boost = row.project_id === this.input.projectId && !scores.has(row.conversation_id) ? CURRENT_PROJECT_BOOST : 0;
        scores.set(row.conversation_id, (scores.get(row.conversation_id) ?? 0) + 1 / (RRF_K + index) + boost);
      });
    }
    const ranked = [...scores].map(([id, score]) => ({ id, score })).sort((left, right) => right.score - left.score);
    return { terms, total, ranked };
  }

  /** Les conversations d'un classement FTS, chacune à sa meilleure ligne. */
  private rank(match: string, kinds: string[], weights: string): Array<{ conversation_id: string; project_id: string }> {
    return this.deps.db.query(`
      WITH hits AS MATERIALIZED (
        SELECT conversation_id, project_id, bm25(search_index, 0.0, 0.0, 0.0, 0.0, ${weights}) AS rank
        FROM search_index
        WHERE search_index MATCH ? AND kind IN (${kinds.map(() => "?").join(", ")})
          AND project_id IN (SELECT id FROM projects WHERE removed_at IS NULL)
      )
      SELECT conversation_id, project_id, MIN(rank) AS best FROM hits
      WHERE conversation_id IN (SELECT id FROM conversations WHERE deleted_at IS NULL)
      GROUP BY conversation_id
      ORDER BY best
      LIMIT ${RANKED_CONVERSATIONS}
    `).all(match, ...kinds) as Array<{ conversation_id: string; project_id: string }>;
  }

  candidates(text: JarvisTextSearch, semantic: SemanticSearchHit[]): string[] {
    const scores = new Map(text.ranked.map((row) => [row.id, row.score]));
    semantic.forEach((hit, index) => {
      const weight = hit.match === "strong" ? 1.5 : 1;
      scores.set(hit.conversation.id, (scores.get(hit.conversation.id) ?? 0) + weight / (RRF_K + index));
    });
    return [...scores]
      .sort((left, right) => right[1] - left[1])
      .map(([id]) => id)
      .filter((id) => id !== this.input.conversationId)
      .slice(0, MAX_CANDIDATES);
  }

  servers(): JarvisServers {
    const projects = this.deps.projects.list();
    const names = new Map(projects.map((project) => [project.id, project.name]));
    const contexts: ApplicationContext[] = projects.map((project) => ({
      projectId: project.id,
      projectName: project.name,
      root: projectCwd(project),
      kind: "project" as const,
    }));
    const rows = this.deps.db.query(`
      SELECT id, project_id, worktree_path, worktree_paths FROM conversations
      WHERE deleted_at IS NULL AND (worktree_path IS NOT NULL OR worktree_paths NOT IN ('', '[]'))
      ORDER BY updated_at DESC
    `).all() as Array<{ id: string; project_id: string; worktree_path: string | null; worktree_paths: string | null }>;
    const byRoot = new Map<string, string[]>();
    for (const row of rows) {
      const projectName = names.get(row.project_id);
      if (!projectName) continue;
      for (const root of worktreeRoots(row.worktree_paths, row.worktree_path)) {
        const key = canonicalPath(root);
        if (!byRoot.has(key)) {
          byRoot.set(key, []);
          contexts.push({ projectId: row.project_id, projectName, root, kind: "worktree" });
        }
        byRoot.get(key)!.push(row.id);
      }
    }
    const applications = this.deps.runningApplications(contexts);
    const normalized = contexts.map((context) => ({ ...context, root: canonicalPath(context.root) }));
    const linked = new Map<string, string[]>();
    for (const application of applications) {
      const context = contextForCwd(application.cwd, normalized);
      linked.set(
        application.id,
        context?.kind === "worktree" ? (byRoot.get(context.root) ?? []).slice(0, MAX_LINKED_CONVERSATIONS) : [],
      );
    }
    return { applications, linked };
  }

  assemble(parts: {
    live: JarvisLiveState;
    text: JarvisTextSearch;
    candidates: string[];
    semantic: SemanticSearchHit[];
    servers: JarvisServers;
  }): JarvisContext {
    const tags = new Map<string, Set<JarvisConversationTag>>();
    const tag = (id: string, value: JarvisConversationTag) => {
      const known = tags.get(id);
      if (known) known.add(value);
      else tags.set(id, new Set([value]));
    };
    if (this.input.conversationId) tag(this.input.conversationId, "current");
    for (const id of [...parts.live.waiting.keys()].slice(0, MAX_STATE_ENTRIES)) tag(id, "waiting");
    for (const id of [...parts.live.running.keys()].slice(0, MAX_STATE_ENTRIES)) tag(id, "running");
    for (const id of parts.candidates) tag(id, "match");
    for (const id of parts.live.unread.slice(0, MAX_UNREAD_ENTRIES)) tag(id, "unread");
    for (const ids of parts.servers.linked.values()) for (const id of ids) tag(id, "server");
    const recent = this.deps.db.query(`
      SELECT c.id FROM conversations c JOIN projects p ON p.id = c.project_id
      WHERE c.deleted_at IS NULL AND c.archived = 0 AND p.removed_at IS NULL
      ORDER BY c.updated_at DESC LIMIT ?
    `).all(MAX_RECENT_ENTRIES + tags.size) as Array<{ id: string }>;
    let added = 0;
    for (const row of recent) {
      if (added >= MAX_RECENT_ENTRIES) break;
      if (tags.has(row.id)) continue;
      tag(row.id, "recent");
      added += 1;
    }

    const rows = this.metadata([...tags.keys()]);
    const semanticReasons = new Map(parts.semantic.map((hit) => [hit.conversation.id, hit.reason.trim() || null]));
    const matched = this.matchedExcerpts(
      [...tags].filter(([, values]) => values.has("match") || values.has("current")).map(([id]) => id),
      parts.text.terms,
    );
    const conversations: JarvisConversationEntry[] = [];
    for (const [id, values] of tags) {
      const row = rows.get(id);
      if (!row) continue;
      const running = parts.live.running.get(id) ?? null;
      const waiting = parts.live.waiting.get(id) ?? null;
      const unread = row.answered_turn > row.last_read_turn;
      const status = running ? "running"
        : waiting ? "waiting"
        : row.archived ? "archived"
        : unread ? "unread"
        : "idle";
      const lastCount = values.has("current") ? 4 : values.has("match") ? 2 : 1;
      const excerpts = new Map<number, JarvisExcerpt>();
      for (const excerpt of (matched.get(id) ?? []).slice(0, values.has("current") ? 4 : MAX_MATCHED_EXCERPTS)) {
        excerpts.set(excerpt.id, excerpt);
      }
      for (const excerpt of this.lastMessages(id, lastCount)) {
        if (!excerpts.has(excerpt.id)) excerpts.set(excerpt.id, excerpt);
      }
      conversations.push({
        alias: `c${conversations.length + 1}`,
        id,
        projectId: row.project_id,
        projectName: row.project_name,
        title: row.title,
        summary: row.summary && row.summary !== row.title ? row.summary : "",
        status,
        pinned: !!row.pinned,
        ticketKey: row.ticket_key,
        ticketUrl: row.ticket_url,
        branch: row.worktree_path ? readHead(row.worktree_path).branch : null,
        updatedAt: row.updated_at,
        tags: [...values],
        running,
        waiting,
        semanticReason: semanticReasons.get(id) ?? null,
        excerpts: [...excerpts.values()].sort((left, right) => left.id - right.id).slice(-MAX_EXCERPTS),
      });
    }

    const projects = this.deps.projects.list().map((project, index): JarvisProjectEntry => ({
      alias: `p${index + 1}`,
      id: project.id,
      name: project.name,
      current: project.id === this.input.projectId,
    }));
    const projectAlias = new Map(projects.map((project) => [project.id, project.alias]));
    const aliasOf = new Map(conversations.map((entry) => [entry.id, entry.alias]));
    const servers = parts.servers.applications.map((application, index): JarvisServerEntry => ({
      alias: `s${index + 1}`,
      url: application.url,
      port: application.port,
      name: application.name,
      process: application.process,
      projectId: application.projectId,
      projectName: application.projectName,
      workspace: application.workspace,
      branch: application.branch,
      conversations: (parts.servers.linked.get(application.id) ?? [])
        .map((id) => aliasOf.get(id))
        .filter((alias): alias is string => alias !== undefined),
    }));
    const tickets = this.citedTickets(projectAlias);
    return {
      now: this.now,
      question: this.input.question,
      history: this.input.history,
      currentProject: projects.find((project) => project.current) ?? null,
      currentConversation: conversations.find((entry) => entry.tags.includes("current")) ?? null,
      projects,
      conversations,
      servers,
      tickets,
      totals: liveTotals(parts.live),
    };
  }

  private metadata(ids: string[]): Map<string, ConversationRow> {
    if (ids.length === 0) return new Map();
    const rows = this.deps.db.query(`
      SELECT c.id, c.project_id, p.name AS project_name, c.title, c.summary, c.archived, c.pinned,
             c.answered_turn, c.last_read_turn, c.updated_at, c.worktree_path,
             t.key AS ticket_key, t.external_url AS ticket_url
      FROM conversations c
      JOIN projects p ON p.id = c.project_id
      LEFT JOIN tickets t ON t.id = c.ticket_id
      WHERE c.id IN (${ids.map(() => "?").join(", ")}) AND c.deleted_at IS NULL AND p.removed_at IS NULL
    `).all(...ids) as ConversationRow[];
    return new Map(rows.map((row) => [row.id, row]));
  }

  /**
   * Messages qui contiennent les mots de la question, classés sur leur seul
   * texte. Les messages des sous-tâches sont indexés sous la conversation
   * parente mais vivent dans un autre flux : l'interface ne saurait pas les
   * retrouver dans le fil, on les écarte.
   */
  private matchedExcerpts(ids: string[], terms: string[]): Map<string, JarvisExcerpt[]> {
    const result = new Map<string, JarvisExcerpt[]>();
    if (ids.length === 0 || terms.length === 0) return result;
    const hits = this.deps.db.query(`
      SELECT source_id, conversation_id, snippet(search_index, 5, '', '', '…', 28) AS excerpt
      FROM search_index
      WHERE search_index MATCH ? AND kind = 'event' AND conversation_id IN (${ids.map(() => "?").join(", ")})
      ORDER BY bm25(search_index, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0)
      LIMIT 400
    `).all(`body : (${terms.join(" OR ")})`, ...ids) as Array<{ source_id: string; conversation_id: string; excerpt: string }>;
    const perConversation = new Map<string, Array<{ id: number; excerpt: string }>>();
    for (const hit of hits) {
      const list = perConversation.get(hit.conversation_id) ?? [];
      if (list.length >= MAX_MATCHED_EXCERPTS) continue;
      list.push({ id: Number(hit.source_id), excerpt: hit.excerpt });
      perConversation.set(hit.conversation_id, list);
    }
    const eventIds = [...perConversation.values()].flat().map((hit) => hit.id).filter(Number.isInteger);
    if (eventIds.length === 0) return result;
    const events = new Map((this.deps.db.query(`
      SELECT id, conversation_id, created_at, json_extract(payload, '$.type') AS type
      FROM events WHERE id IN (${eventIds.map(() => "?").join(", ")})
    `).all(...eventIds) as Array<{ id: number; conversation_id: string; created_at: string; type: string }>)
      .map((row) => [Number(row.id), row]));
    for (const [conversationId, list] of perConversation) {
      const excerpts: JarvisExcerpt[] = [];
      for (const hit of list) {
        const event = events.get(hit.id);
        if (!event || event.conversation_id !== conversationId) continue;
        excerpts.push({
          id: hit.id,
          at: event.created_at,
          role: event.type === "user-message" ? "user" : "agent",
          text: plainExcerpt(hit.excerpt, EXCERPT_CHARS),
          matched: true,
        });
      }
      if (excerpts.length > 0) result.set(conversationId, excerpts);
    }
    return result;
  }

  private lastMessages(conversationId: string, count: number): JarvisExcerpt[] {
    return this.lastEvents(conversationId, count)
      .map((excerpt) => ({ ...excerpt, text: plainExcerpt(excerpt.text, EXCERPT_CHARS) }))
      .sort((left, right) => left.id - right.id);
  }

  /** Derniers messages du fil principal, du plus récent au plus ancien, texte intégral. */
  private lastEvents(conversationId: string, count: number): JarvisExcerpt[] {
    const rows = this.deps.db.query(`
      SELECT id, created_at, payload FROM events
      WHERE conversation_id = ? AND json_extract(payload, '$.type') IN ('user-message', 'text-final')
      ORDER BY id DESC LIMIT ?
    `).all(conversationId, count) as Array<{ id: number; created_at: string; payload: string }>;
    const excerpts: JarvisExcerpt[] = [];
    for (const row of rows) {
      try {
        const event = JSON.parse(row.payload) as { type?: string; text?: unknown };
        if (typeof event.text !== "string" || !event.text.trim()) continue;
        excerpts.push({
          id: Number(row.id),
          at: row.created_at,
          role: event.type === "user-message" ? "user" : "agent",
          text: event.text,
          matched: false,
        });
      } catch {
        // Événement corrompu : il ne fournit pas d'extrait.
      }
    }
    return excerpts;
  }

  private citedTickets(projectAlias: Map<string, string>): JarvisTicketEntry[] {
    const previous = this.input.history.findLast((entry) => entry.role === "user")?.text ?? "";
    const keys = ticketKeysIn(`${this.input.question} ${previous}`);
    if (keys.length === 0) return [];
    const rows = this.deps.db.query(`
      SELECT t.key, t.title, t.status, t.external_url, t.project_id FROM tickets t
      JOIN projects p ON p.id = t.project_id
      WHERE p.removed_at IS NULL AND UPPER(t.key) IN (${keys.map(() => "?").join(", ")})
      LIMIT 10
    `).all(...keys) as Array<{ key: string; title: string; status: string; external_url: string | null; project_id: string }>;
    return rows.flatMap((row) => {
      const alias = projectAlias.get(row.project_id);
      return alias ? [{ key: row.key, title: row.title, status: row.status, url: row.external_url, projectAlias: alias }] : [];
    });
  }
}
