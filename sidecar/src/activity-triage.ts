import type { ActivityMotif, ActivityStore } from "./stores/activity";
import { localDay } from "./time-tracking";

/** Motifs affichés par projet ; le reste attend en réserve. */
export const TRIAGE_TOP = 10;
/** Un motif ouvert sans nouvelle preuve depuis ce nombre de jours est écarté. */
export const TRIAGE_STALE_DAYS = 30;
const TRIAGE_REASON_MAX = 160;

export const TRIAGE_MODEL = {
  provider: "claude" as const,
  model: "sonnet-5.5",
  effort: "medium",
  speed: "standard" as const,
};

export interface TriageResult {
  ranking: Array<{ id: string; stars: number; reason: string }>;
  merges: Array<{ keep: string; absorb: string[] }>;
}

/** Fenêtre d'apparition d'un motif « nouveau », la même que l'encart « En hausse » de l'UI. */
export const TRIAGE_NEW_DAYS = 7;

/**
 * Motifs notés 5 à leur tout premier tri et apparus dans la fenêtre : la
 * première note n'arrive qu'une fois, donc chaque motif n'alerte qu'une fois.
 */
export function newTopMotifs(before: ActivityMotif[], after: ActivityMotif[], day: string): ActivityMotif[] {
  const unrated = new Set(before.filter((motif) => motif.stars === null).map((motif) => motif.id));
  const since = new Date(`${day}T12:00:00`);
  since.setDate(since.getDate() - TRIAGE_NEW_DAYS);
  return after.filter((motif) => unrated.has(motif.id) && motif.stars === 5 && motif.first_seen_day >= localDay(since));
}

/** Rien à retrier tant qu'aucun motif ouvert n'a bougé depuis le dernier tri. */
export function needsTriage(open: ActivityMotif[]): boolean {
  return open.some((motif) => motif.ranked_at === null || motif.updated_at > motif.ranked_at);
}

export function staleBefore(day: string): string {
  const date = new Date(`${day}T12:00:00`);
  date.setDate(date.getDate() - TRIAGE_STALE_DAYS);
  return localDay(date);
}

export function triagePrompt(projectName: string, day: string, open: ActivityMotif[]): string {
  const material = open.map((motif) => ({
    id: motif.id,
    kind: motif.kind,
    title: motif.title,
    statement: motif.statement,
    firstSeen: motif.first_seen_day,
    lastSeen: motif.last_seen_day,
    evidence: motif.evidence.length,
    evidenceDays: new Set(motif.evidence.map((item) => item.day)).size,
    previousStars: motif.stars,
  }));
  return [
    `Tu tries les constats de recul du projet « ${projectName} » au ${day}. Ils viennent d'une passe quotidienne qui relève les frictions, erreurs récurrentes, choses à stabiliser et idées dans le travail d'un développeur avec ses agents de code.`,
    `Le but : qu'il ne voie que les ${TRIAGE_TOP} constats qui lui feraient le plus gagner de temps ou éviter le plus d'erreurs s'il les traitait.`,
    "",
    "1. Fusionne les doublons : deux constats qui décrivent le même problème. Garde le plus précis.",
    `2. Note chaque constat restant de 1 à 5 étoiles selon l'impact : fréquence (evidenceDays), temps perdu à chaque occurrence, risque d'erreur, effet sur la vitesse de livraison. 5 = change la donne s'il est traité ; 1 = anecdotique. Sois exigeant : peu de 5.`,
    `3. Classe-les du plus au moins important et garde les ${TRIAGE_TOP} premiers. Les autres partent en réserve : ne les cite pas.`,
    "",
    "Réponds UNIQUEMENT par un objet JSON, sans texte autour, sans bloc de code :",
    '{"merges": [{"keep": "<id>", "absorb": ["<id>"]}], "ranking": [{"id": "<id>", "stars": 4, "reason": "…"}]}',
    `- reason : une phrase en français (${TRIAGE_REASON_MAX} caractères maximum) qui justifie la note par un fait : fréquence, coût, risque.`,
    "",
    `CONSTATS OUVERTS : ${JSON.stringify(material)}`,
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

/**
 * Filtre la sortie du tri : identifiants inconnus ou absorbés écartés, notes
 * ramenées entre 1 et 5, top borné, ordre stable par note décroissante.
 */
export function parseTriage(raw: string, open: ActivityMotif[]): TriageResult {
  const payload = extractJson(raw) as { ranking?: unknown; merges?: unknown } | null;
  if (!payload || !Array.isArray(payload.ranking)) throw new Error("réponse de tri illisible");
  const ids = new Set(open.map((motif) => motif.id));
  const absorbed = new Set<string>();
  const merges: TriageResult["merges"] = [];
  for (const item of Array.isArray(payload.merges) ? payload.merges : []) {
    if (!item || typeof item !== "object") continue;
    const keep = String((item as { keep?: unknown }).keep ?? "");
    const absorb = (item as { absorb?: unknown }).absorb;
    if (!ids.has(keep) || absorbed.has(keep) || !Array.isArray(absorb)) continue;
    const valid = absorb.filter((id): id is string => typeof id === "string" && ids.has(id) && id !== keep && !absorbed.has(id));
    if (valid.length === 0) continue;
    for (const id of valid) absorbed.add(id);
    merges.push({ keep, absorb: valid });
  }
  const seen = new Set<string>();
  const ranking: TriageResult["ranking"] = [];
  for (const item of payload.ranking) {
    if (!item || typeof item !== "object") continue;
    const id = String((item as { id?: unknown }).id ?? "");
    const stars = Number((item as { stars?: unknown }).stars);
    if (!ids.has(id) || absorbed.has(id) || seen.has(id) || !Number.isFinite(stars)) continue;
    seen.add(id);
    const reason = String((item as { reason?: unknown }).reason ?? "").trim();
    ranking.push({ id, stars: Math.min(5, Math.max(1, Math.round(stars))), reason: reason.slice(0, TRIAGE_REASON_MAX) });
  }
  ranking.sort((left, right) => right.stars - left.stars);
  return { ranking: ranking.slice(0, TRIAGE_TOP), merges };
}

export function applyTriage(store: ActivityStore, projectId: string, day: string, result: TriageResult, now: string): void {
  for (const merge of result.merges) store.mergeMotifs(merge.keep, merge.absorb, now);
  store.applyRanking(projectId, day, result.ranking, now);
}
