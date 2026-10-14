import type { ConversationReference } from "./stores/conversations";

const MENTION = /(^|\s)@\[([^\]\n]{1,200})\]/gu;

function normalized(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();
}

/** Titre exact d'abord, puis inclusion ; à égalité, la plus récente. */
export function searchConversationReferences(
  references: ConversationReference[],
  query: string,
  limit = 20,
): ConversationReference[] {
  const needle = normalized(query);
  if (!needle) return references.slice(0, limit);
  const exact = references.filter((item) => normalized(item.title) === needle);
  const partial = references.filter((item) => {
    const title = normalized(item.title);
    return title !== needle && title.includes(needle);
  });
  return [...exact, ...partial].slice(0, limit);
}

export function mentionedConversationTitles(prompt: string): string[] {
  return [...new Set([...prompt.matchAll(MENTION)].map((match) => match[2]!.trim()))];
}

export function withConversationMentions(
  prompt: string,
  references: () => ConversationReference[],
): string {
  const titles = mentionedConversationTitles(prompt);
  if (titles.length === 0) return prompt;
  const known = references();
  const lines = titles.map((title) => {
    const match = known.find((item) => normalized(item.title) === normalized(title));
    return match
      ? `- « ${match.title} » (projet ${match.project_name}) : conversation_id \`${match.id}\``
      : `- « ${title} » : aucune conversation de ce titre, cherche-la par nom avec \`read_conversation\``;
  });
  return `${prompt}\n\n[Conversations Pupitre citées]\n${lines.join("\n")}\n`
    + "Lis-les avec l’outil Pupitre `read_conversation` avant de répondre si la demande s’appuie dessus.";
}
