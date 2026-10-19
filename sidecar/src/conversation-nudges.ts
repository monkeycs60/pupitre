import type { Database } from "bun:sqlite";

export type NudgeKind = "choice" | "validate" | "relaunch" | "review";
export type NudgeStage = "fresh" | "stale";

export interface NudgeAction {
  label: string;
  message: string;
}

export interface ConversationNudge {
  id: string;
  conversation_id: string;
  project_id: string;
  project_name: string;
  conversation_title: string;
  kind: NudgeKind;
  title: string;
  body: string;
  actions: NudgeAction[];
  created_at: string;
}

export interface NudgeCandidate {
  conversationId: string;
  projectName: string;
  title: string;
  stage: NudgeStage;
  sourceEventId: number;
  minutesSinceAnswer: number;
  unread: boolean;
  failed: boolean;
  lastAnswer: string;
}

export interface NudgeVerdict {
  conversationId: string;
  kind: NudgeKind | "none";
  title: string;
  body: string;
  actions: NudgeAction[];
}

export type NudgeJudge = (candidates: NudgeCandidate[]) => Promise<NudgeVerdict[]>;

interface NudgeRow {
  id: string;
  conversation_id: string;
  project_id: string;
  project_name: string;
  conversation_title: string;
  kind: NudgeKind;
  title: string;
  body: string;
  actions_json: string;
  source_event_id: number;
  created_at: string;
  answered_turn: number;
  last_read_turn: number;
}

const BATCH_SIZE = 6;
const LOOKBACK_MINUTES = 24 * 60;
const FRESH_DELAY_MINUTES = 3;
const STALE_AFTER_MINUTES = 60;
const ANSWER_TAIL_CHARS = 2_500;
const MAX_ACTIONS = 3;

export class ConversationNudgeService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastScanAt = 0;
  private scanning = false;

  constructor(
    private readonly db: Database,
    private readonly judge: NudgeJudge,
    private readonly intervalMinutes: () => number,
    private readonly isRunning: (conversationId: string) => boolean,
    private readonly todoHeadings: () => string[],
    private readonly now: () => number = Date.now,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_nudges (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        source_event_id INTEGER NOT NULL,
        stage TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        actions_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        closed_at TEXT NULL,
        UNIQUE (conversation_id, source_event_id, stage)
      );
      CREATE INDEX IF NOT EXISTS idx_conversation_nudges_open
        ON conversation_nudges(closed_at, conversation_id);
    `);
  }

  start(): void {
    if (this.timer) return;
    this.lastScanAt = this.now();
    this.timer = setInterval(() => {
      const minutes = this.intervalMinutes();
      if (minutes <= 0 || this.now() - this.lastScanAt < minutes * 60_000) return;
      void this.scan().catch((error) => console.error("[veille] passe impossible", error));
    }, 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  candidates(): NudgeCandidate[] {
    const now = this.now();
    const since = new Date(now - LOOKBACK_MINUTES * 60_000).toISOString();
    const rows = this.db.query(`
      SELECT c.id, c.title, c.answered_turn, c.last_read_turn, p.name AS project_name,
        (SELECT MAX(id) FROM events e WHERE e.conversation_id = c.id
           AND json_extract(e.payload, '$.type') = 'status'
           AND json_extract(e.payload, '$.state') IN ('done', 'error')) AS settled_id,
        (SELECT MAX(id) FROM events e WHERE e.conversation_id = c.id
           AND json_extract(e.payload, '$.type') = 'text-final') AS answer_id,
        (SELECT MAX(id) FROM events e WHERE e.conversation_id = c.id
           AND json_extract(e.payload, '$.type') = 'user-message') AS question_id
      FROM conversations c
      JOIN projects p ON p.id = c.project_id
      WHERE c.deleted_at IS NULL AND c.archived = 0 AND c.handoff_pending = 0
        AND c.answered_turn > 0 AND c.updated_at >= ?
      ORDER BY c.updated_at DESC
    `).all(since) as Array<{
      id: string; title: string; answered_turn: number; last_read_turn: number;
      project_name: string; settled_id: number | null; answer_id: number | null; question_id: number | null;
    }>;
    const evaluated = this.db.query(
      "SELECT 1 FROM conversation_nudges WHERE conversation_id = ? AND source_event_id = ? AND stage = ?",
    );
    const open = this.db.query(
      "SELECT 1 FROM conversation_nudges WHERE conversation_id = ? AND closed_at IS NULL AND kind != 'none'",
    );
    const event = this.db.query("SELECT payload, created_at FROM events WHERE id = ?");
    const headings = this.todoHeadings().map((heading) => heading.toUpperCase());
    const result: NudgeCandidate[] = [];
    for (const row of rows) {
      const settledId = row.settled_id;
      if (settledId === null || (row.question_id ?? 0) > settledId) continue;
      if (this.isRunning(row.id) || open.get(row.id)) continue;
      const settled = event.get(settledId) as { payload: string; created_at: string } | null;
      if (!settled) continue;
      const minutes = Math.floor((now - Date.parse(settled.created_at)) / 60_000);
      if (minutes > LOOKBACK_MINUTES) continue;
      const failed = (JSON.parse(settled.payload) as { state?: string }).state === "error";
      const answered = row.answer_id !== null && row.answer_id > (row.question_id ?? 0)
        ? event.get(row.answer_id) as { payload: string } | null
        : null;
      const text = answered ? String((JSON.parse(answered.payload) as { text?: string }).text ?? "") : "";
      const unread = row.answered_turn > row.last_read_turn;
      const stage: NudgeStage = unread && minutes >= STALE_AFTER_MINUTES ? "stale" : "fresh";
      const asksSomething = failed || hasActionBlock(text, headings);
      if (stage === "fresh" && (!asksSomething || minutes < FRESH_DELAY_MINUTES)) continue;
      if (evaluated.get(row.id, settledId, stage)) continue;
      result.push({
        conversationId: row.id,
        projectName: row.project_name,
        title: row.title,
        stage,
        sourceEventId: settledId,
        minutesSinceAnswer: minutes,
        unread,
        failed,
        lastAnswer: text.length > ANSWER_TAIL_CHARS ? `…${text.slice(-ANSWER_TAIL_CHARS)}` : text,
      });
    }
    return result;
  }

  async scan(): Promise<number> {
    if (this.scanning) return 0;
    this.scanning = true;
    this.lastScanAt = this.now();
    try {
      const batch = this.candidates().slice(0, BATCH_SIZE);
      if (batch.length === 0) return 0;
      const verdicts = new Map((await this.judge(batch)).map((verdict) => [verdict.conversationId, verdict]));
      const insert = this.db.query(`
        INSERT OR IGNORE INTO conversation_nudges
          (id, conversation_id, source_event_id, stage, kind, title, body, actions_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      let created = 0;
      const createdAt = new Date(this.now()).toISOString();
      for (const candidate of batch) {
        const verdict = sanitizeVerdict(verdicts.get(candidate.conversationId), candidate);
        insert.run(
          crypto.randomUUID(), candidate.conversationId, candidate.sourceEventId, candidate.stage,
          verdict.kind, verdict.title, verdict.body, JSON.stringify(verdict.actions), createdAt,
        );
        if (verdict.kind !== "none") created++;
      }
      return created;
    } finally {
      this.scanning = false;
    }
  }

  list(): ConversationNudge[] {
    const rows = this.db.query(`
      SELECT n.id, n.conversation_id, c.project_id, p.name AS project_name, c.title AS conversation_title,
             n.kind, n.title, n.body, n.actions_json, n.source_event_id, n.created_at,
             c.answered_turn, c.last_read_turn
      FROM conversation_nudges n
      JOIN conversations c ON c.id = n.conversation_id
      JOIN projects p ON p.id = c.project_id
      WHERE n.closed_at IS NULL AND n.kind != 'none'
        AND c.deleted_at IS NULL AND c.archived = 0
        AND NOT EXISTS (
          SELECT 1 FROM events e WHERE e.conversation_id = n.conversation_id AND e.id > n.source_event_id
            AND json_extract(e.payload, '$.type') IN ('user-message', 'text-final')
        )
      ORDER BY n.created_at DESC
    `).all() as NudgeRow[];
    return rows
      .filter((row) => row.kind !== "review" || row.answered_turn > row.last_read_turn)
      .filter((row) => !this.isRunning(row.conversation_id))
      .map((row) => ({
        id: row.id,
        conversation_id: row.conversation_id,
        project_id: row.project_id,
        project_name: row.project_name,
        conversation_title: row.conversation_title,
        kind: row.kind,
        title: row.title,
        body: row.body,
        actions: JSON.parse(row.actions_json) as NudgeAction[],
        created_at: row.created_at,
      }));
  }

  close(id: string): boolean {
    const result = this.db.query(
      "UPDATE conversation_nudges SET closed_at = ? WHERE id = ? AND closed_at IS NULL",
    ).run(new Date(this.now()).toISOString(), id);
    return result.changes > 0;
  }
}

function hasActionBlock(text: string, headings: string[]): boolean {
  if (text.includes(" OU ")) return true;
  return text.split("\n").some((line) => {
    const cleaned = line.replace(/[*_#`:>\s]/g, "").toUpperCase();
    return headings.some((heading) => cleaned === heading.replace(/\s/g, ""));
  });
}

function clip(value: unknown, max: number): string {
  const text = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const KINDS: Array<NudgeKind | "none"> = ["choice", "validate", "relaunch", "review", "none"];

function sanitizeVerdict(verdict: NudgeVerdict | undefined, candidate: NudgeCandidate): NudgeVerdict {
  const kind = verdict && KINDS.includes(verdict.kind) ? verdict.kind : "none";
  const actions = (Array.isArray(verdict?.actions) ? verdict.actions : [])
    .map((action) => ({ label: clip(action?.label, 48), message: clip(action?.message, 600) }))
    .filter((action) => action.label && action.message)
    .slice(0, MAX_ACTIONS);
  const title = clip(verdict?.title, 90);
  if (kind === "none" || !title) return { conversationId: candidate.conversationId, kind: "none", title: "", body: "", actions: [] };
  return { conversationId: candidate.conversationId, kind, title, body: clip(verdict?.body, 240), actions };
}

export function nudgePrompt(candidates: NudgeCandidate[]): string {
  const blocks = candidates.map((candidate) => [
    `<conversation id="${candidate.conversationId}">`,
    `Projet : ${candidate.projectName}`,
    `Titre : ${candidate.title}`,
    `Dernière réponse il y a ${candidate.minutesSinceAnswer} min, ${candidate.unread ? "non lue" : "déjà lue"}${candidate.failed ? ", tour terminé en erreur" : ""}.`,
    "Fin de la dernière réponse de l'agent :",
    candidate.lastAnswer,
    "</conversation>",
  ].join("\n"));
  return `Tu veilles sur les conversations de Clément avec ses agents de code. Il travaille sur plusieurs conversations à la fois et rate les petites décisions qui bloquent un agent. Pour chaque conversation ci-dessous, décide si une notification vaut la peine de l'interrompre.

Types :
- "choice" : l'agent attend une décision simple entre options (souvent une ligne « question : A OU B » dans un bloc TODO). Une action par option.
- "validate" : l'agent propose une suite évidente qu'il suffit d'autoriser (committer, lancer, appliquer). Une action « oui », éventuellement une action alternative.
- "relaunch" : le tour s'est arrêté en erreur ou au milieu du travail ; une action relance.
- "review" : rien à cliquer, mais une réponse importante attend depuis longtemps sans avoir été lue. Aucune action.
- "none" : tout le reste, notamment une tâche terminée sans question, des TODO qui demandent un travail manuel de Clément hors de la conversation, ou un choix qui demande de lire le détail.

Chaque action contient "label" (2 à 5 mots, ce que Clément clique) et "message" (le texte exact envoyé à l'agent en son nom, à la première personne, court). Pour un choix, écris le message sous la forme « Réponse à « question » : option ». N'invente aucune option absente de la réponse.
"title" résume en une phrase courte ce qui attend Clément ; "body" donne le contexte minimal pour décider sans ouvrir la conversation (une ou deux phrases). Rédige en français.

Réponds uniquement en JSON : {"nudges":[{"conversationId":"…","kind":"choice|validate|relaunch|review|none","title":"…","body":"…","actions":[{"label":"…","message":"…"}]}]}

${blocks.join("\n\n")}`;
}

export function parseNudgeVerdicts(raw: unknown): NudgeVerdict[] {
  const list = (raw as { nudges?: unknown } | null)?.nudges;
  return Array.isArray(list) ? list.filter((item): item is NudgeVerdict => typeof item?.conversationId === "string") : [];
}
