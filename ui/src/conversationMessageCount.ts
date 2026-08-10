export interface ConversationMessageCountEvent {
  type?: string;
}

/** Compte un message utilisateur et une seule réponse assistant par tour. */
export function countConversationMessages(
  events: Iterable<ConversationMessageCountEvent>,
): number {
  let count = 0;
  let assistantResponseCounted = false;

  for (const event of events) {
    if (event.type === 'user-message') {
      count += 1;
      assistantResponseCounted = false;
    } else if (event.type === 'text-final' && !assistantResponseCounted) {
      count += 1;
      assistantResponseCounted = true;
    }
  }

  return count;
}
