import type { StoredEvent } from "./events";
import type { JournalProject } from "./activity-report";
import type { Problem } from "./stores/problems";
import {
  ACTIVITY_EVIDENCE_KINDS,
  ACTIVITY_MOTIF_KINDS,
  type ActivityEvidenceKind,
  type ActivityMotif,
  type ActivityMotifKind,
  type ActivityStore,
} from "./stores/activity";

/** Un motif n'existe qu'appuyé sur deux preuves distinctes : une seule est une anecdote. */
export const MIN_MOTIF_EVIDENCE = 2;
/** Bornes de la matière du jour envoyée au modèle fort, par conversation puis par projet. */
export const RETRO_CONVERSATION_CHARS = 30_000;
export const RETRO_PROJECT_CHARS = 150_000;
const RETRO_EVENT_CHARS = 3_000;
const RETRO_MIN_CONVERSATION_CHARS = 2_000;
const RETRO_STATE_EVIDENCE_LABELS = 4;

export interface RetroEvidenceInput {
  kind: ActivityEvidenceKind;
  ref: string;
  label: string;
}

export type RetroOperation =
  | { op: "create"; kind: ActivityMotifKind; title: string; statement: string; evidence: RetroEvidenceInput[] }
  | { op: "update"; id: string; statement: string | null; evidence: RetroEvidenceInput[] }
  | { op: "stabilize"; id: string; evidence: RetroEvidenceInput[] };

export interface RetroChanges {
  created: string[];
  updated: string[];
  stabilized: string[];
  returned: string[];
}

/** Identifiants réellement présents dans la matière du jour ou du projet, avec leur libellé. */
export interface KnownRefs {
  conversation: Map<string, string>;
  commit: Map<string, string>;
  ticket: Map<string, string>;
  problem: Map<string, string>;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[… tronqué …]`;
}

function transcriptLine(event: StoredEvent): string | null {
  switch (event.type) {
    case "user-message":
      return `Utilisateur :\n${clip(event.text, RETRO_EVENT_CHARS)}`;
    case "text-final":
      return `Agent :\n${clip(event.text, RETRO_EVENT_CHARS)}`;
    case "tool-start":
      return `Outil ${event.toolName} : ${clip(JSON.stringify(event.input), 400)}`;
    case "tool-end":
      return `Résultat d'outil : ${clip(event.output, 600)}`;
    case "status":
      return event.state === "error" ? `Erreur : ${event.error ?? "inconnue"}` : null;
    default:
      return null;
  }
}

/** Transcription d'une conversation bornée : le début et la fin survivent, le milieu est coupé. */
export function boundedTranscript(events: StoredEvent[], budget: number): string {
  const lines = events.map(transcriptLine).filter((line): line is string => line !== null);
  const full = lines.join("\n\n");
  if (full.length <= budget) return full;
  const head = Math.floor(budget * 0.6);
  const tail = budget - head;
  return `${full.slice(0, head)}\n\n[… ${full.length - budget} caractères coupés au milieu de la conversation …]\n\n${full.slice(full.length - tail)}`;
}

export function knownRefsFor(project: JournalProject, problems: Problem[]): KnownRefs {
  return {
    conversation: new Map(project.conversations.map((conversation) => [conversation.id, conversation.title])),
    commit: new Map(project.commits.map((commit) => [commit.sha, commit.productMessage ?? commit.subject])),
    ticket: new Map(project.tickets.map((ticket) => [ticket.id, `${ticket.key} ${ticket.title}`])),
    problem: new Map(problems.map((problem) => [problem.id, `${problem.public_id} ${problem.title}`])),
  };
}

function stateForPrompt(motifs: ActivityMotif[]) {
  return motifs.map((motif) => ({
    id: motif.id,
    kind: motif.kind,
    status: motif.status,
    title: motif.title,
    statement: motif.statement,
    firstSeen: motif.first_seen_day,
    lastSeen: motif.last_seen_day,
    evidenceCount: motif.evidence.length,
    evidence: motif.evidence.slice(-RETRO_STATE_EVIDENCE_LABELS).map((item) => `${item.kind} ${item.ref.slice(0, 8)} · ${item.label}`),
  }));
}

/**
 * La matière du jour d'un projet : transcriptions bornées par conversation
 * (les plus longues en présence d'abord), commits, tickets, tâches, problèmes
 * ouverts. Le passé n'entre que par l'état des motifs.
 */
export function retroPrompt(
  project: JournalProject,
  day: string,
  motifs: ActivityMotif[],
  problems: Problem[],
): string {
  let remaining = RETRO_PROJECT_CHARS;
  const conversations = [...project.conversations]
    .sort((left, right) => right.userMs - left.userMs || right.turns - left.turns)
    .map((conversation) => {
      const budget = Math.min(RETRO_CONVERSATION_CHARS, remaining);
      const transcript = budget >= RETRO_MIN_CONVERSATION_CHARS ? boundedTranscript(conversation.events, budget) : "[transcription omise : budget du jour épuisé]";
      remaining = Math.max(0, remaining - transcript.length);
      return {
        id: conversation.id,
        title: conversation.title,
        ticket: conversation.ticketKey,
        startedDay: conversation.startedDay,
        userMinutes: Math.round(conversation.userMs / 60_000),
        transcript,
      };
    });
  const commits = project.commits.map((commit) => ({
    sha: commit.sha,
    subject: commit.subject,
    productMessage: commit.productMessage,
    branch: commit.branch,
    lines: commit.linesAdded === null ? null : `+${commit.linesAdded} −${commit.linesRemoved ?? 0}`,
    conversationId: commit.conversationId,
  }));
  return [
    `Tu entretiens l'état de recul d'un développeur sur le projet « ${project.projectName} ». Lecteur : lui seul. Ton de constat, jamais de reproche, aucune objection inventée.`,
    `Tu reçois l'ÉTAT courant (motifs déjà connus) et la MATIÈRE du ${day} uniquement. Ta mémoire du passé, c'est l'état : ne suppose rien d'autre.`,
    "",
    "Un motif est l'un de ces quatre types :",
    "- recurrence : un sujet qui revient sans se régler (plusieurs conversations sur le même point, sans commit qui le ferme).",
    "- stabilize : une zone du code ou de l'outillage à stabiliser (corrections répétées, bugs en chaîne au même endroit).",
    "- practice : une dérive ou une habitude de travail qui coûte (relances, contournements, vérifications oubliées).",
    "- idea : une piste concrète issue du recoupement tickets / commits / demandes en conversation.",
    "",
    "Règles strictes :",
    `- Chaque motif créé cite au moins ${MIN_MOTIF_EVIDENCE} preuves distinctes prises dans la matière du jour : identifiants exacts de conversations (conversation), SHA de commits (commit), identifiants de tickets (ticket) ou de problèmes (problem). Sans preuves, pas de motif.`,
    "- Si un motif existant est concerné, mets-le à jour (op update) avec les nouvelles preuves plutôt que d'en créer un second. Un motif écarté (dismissed) ne se met à jour que si la matière du jour apporte une preuve vraiment nouvelle.",
    "- Si un commit du jour règle un motif ouvert, stabilise-le (op stabilize) en citant ce commit.",
    "- N'en crée pas pour remplir : une journée ordinaire produit souvent zéro motif nouveau.",
    "",
    "Réponds UNIQUEMENT par un objet JSON, sans texte autour, sans bloc de code :",
    '{"operations": [',
    '  {"op": "create", "kind": "recurrence|stabilize|practice|idea", "title": "…", "statement": "…", "evidence": [{"kind": "conversation|commit|ticket|problem", "ref": "…"}]},',
    '  {"op": "update", "id": "<id de motif>", "statement": "…ou null…", "evidence": [ … ]},',
    '  {"op": "stabilize", "id": "<id de motif>", "evidence": [{"kind": "commit", "ref": "<sha>"}]}',
    "]}",
    "- title : 80 caractères maximum, en français. statement : 2 phrases maximum, le constat et la piste, sans jugement.",
    "",
    `ÉTAT : ${JSON.stringify(stateForPrompt(motifs))}`,
    "",
    `MATIÈRE DU ${day} : ${JSON.stringify({
      hours: { user: Math.round(project.userMs / 60_000), agent: Math.round(project.agentMs / 60_000) },
      conversations,
      commits,
      tickets: project.tickets.map((ticket) => ({ id: ticket.id, key: ticket.key, title: ticket.title })),
      todosDone: project.todosDone.map((todo) => todo.title),
      openProblems: problems.map((problem) => ({ id: problem.id, publicId: problem.public_id, title: problem.title })),
    })}`,
  ].join("\n");
}

function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function parseEvidence(raw: unknown, known: KnownRefs): RetroEvidenceInput[] {
  if (!Array.isArray(raw)) return [];
  const out: RetroEvidenceInput[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const kind = (item as { kind?: unknown }).kind;
    const ref = String((item as { ref?: unknown }).ref ?? "").trim();
    if (!ACTIVITY_EVIDENCE_KINDS.includes(kind as ActivityEvidenceKind) || !ref) continue;
    const label = known[kind as ActivityEvidenceKind].get(ref);
    if (label === undefined) continue;
    const key = `${kind}:${ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: kind as ActivityEvidenceKind, ref, label });
  }
  return out;
}

/**
 * Filtre la sortie du modèle : identifiants inconnus écartés, création sans
 * deux preuves écartée, stabilisation sans commit écartée, motif inconnu
 * ignoré. Une sortie illisible lève : la passe note l'erreur, le journal reste.
 */
export function parseRetroOperations(raw: string, known: KnownRefs, motifs: ActivityMotif[]): RetroOperation[] {
  const payload = extractJson(raw) as { operations?: unknown } | null;
  if (!payload || !Array.isArray(payload.operations)) throw new Error("réponse de recul illisible");
  const ids = new Set(motifs.map((motif) => motif.id));
  const operations: RetroOperation[] = [];
  for (const item of payload.operations) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const evidence = parseEvidence(record.evidence, known);
    if (record.op === "create") {
      const kind = record.kind;
      const title = String(record.title ?? "").trim();
      const statement = String(record.statement ?? "").trim();
      if (!ACTIVITY_MOTIF_KINDS.includes(kind as ActivityMotifKind) || !title || !statement) continue;
      if (evidence.length < MIN_MOTIF_EVIDENCE) continue;
      operations.push({ op: "create", kind: kind as ActivityMotifKind, title, statement, evidence });
      continue;
    }
    const id = String(record.id ?? "");
    if (!ids.has(id)) continue;
    if (record.op === "update") {
      if (evidence.length === 0) continue;
      const statement = typeof record.statement === "string" && record.statement.trim() ? record.statement.trim() : null;
      operations.push({ op: "update", id, statement, evidence });
    } else if (record.op === "stabilize") {
      if (!evidence.some((item) => item.kind === "commit")) continue;
      operations.push({ op: "stabilize", id, evidence });
    }
  }
  return operations;
}

/**
 * Applique les opérations validées. Un motif écarté qui reçoit une preuve
 * nouvelle repasse ouvert et marqué « revenu » ; un motif pris en charge
 * garde son statut et accumule seulement les preuves.
 */
export function applyRetroOperations(
  store: ActivityStore,
  projectId: string,
  day: string,
  operations: RetroOperation[],
  now: string,
): RetroChanges {
  const changes: RetroChanges = { created: [], updated: [], stabilized: [], returned: [] };
  for (const operation of operations) {
    if (operation.op === "create") {
      const motif = store.createMotif({
        projectId, kind: operation.kind, title: operation.title, statement: operation.statement, day, evidence: operation.evidence,
      }, now);
      changes.created.push(motif.id);
      continue;
    }
    const motif = store.motif(operation.id);
    if (!motif || motif.project_id !== projectId) continue;
    const added = store.addEvidence(motif.id, day, operation.evidence, now);
    if (operation.op === "stabilize") {
      if (motif.status === "open" || motif.status === "handled") {
        store.updateMotif(motif.id, { status: "stabilized", last_seen_day: day }, now);
        changes.stabilized.push(motif.id);
      }
      continue;
    }
    if (added === 0) continue;
    if (motif.status === "dismissed") {
      store.updateMotif(motif.id, { status: "open", returned_at: now, statement: operation.statement ?? undefined }, now);
      changes.returned.push(motif.id);
    } else {
      store.updateMotif(motif.id, { statement: operation.statement ?? undefined }, now);
      changes.updated.push(motif.id);
    }
  }
  return changes;
}
