const GREETING_PREFIX = /^(?:bonjour|bonsoir|hello|hi|salut)\b[\s,!:.-]*/iu;
const REQUEST_PREFIX = /^(?:(?:tu|vous)\s+peux?\s+|peux?-tu\s+|pourrais-tu\s+|merci\s+de\s+|est-ce\s+que\s+tu\s+peux\s+)/iu;

const TITLE_MAX = 47;
const SUMMARY_MAX = 240;

function cleanMessage(message: string): string {
  return message
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(GREETING_PREFIX, "")
    .replace(REQUEST_PREFIX, "")
    .trim();
}

function firstSentence(text: string): string {
  const match = text.match(/^(.+?[.!?])(?:\s|$)/u);
  return match?.[1]?.trim() || text;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const boundary = text.slice(0, max - 1).lastIndexOf(" ");
  const end = boundary > Math.floor(max * 0.55) ? boundary : max - 1;
  return `${text.slice(0, end).trimEnd()}…`;
}

function truncateTitle(text: string): string {
  if (text.length <= TITLE_MAX) return text;
  return `${text.slice(0, TITLE_MAX)}…`;
}

/** Titre local : on retire les formules de politesse et garde l'action. */
export function taskTitle(message: string): string {
  const cleaned = cleanMessage(message);
  return truncateTitle(firstSentence(cleaned || "Nouvelle tâche"));
}

/** Résumé court, affichable dans un aperçu de conversation. */
export function taskSummary(message: string): string {
  const cleaned = cleanMessage(message);
  return truncate(cleaned || "Aucune consigne fournie", SUMMARY_MAX);
}
