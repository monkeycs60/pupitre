export interface MessageCountEvent {
  type?: string;
}

/**
 * Compte les messages visibles comme une paire utilisateur + assistant par
 * tour, sans compter plusieurs sorties assistant séparées par des outils.
 */
export function countConversationMessages(events: Iterable<MessageCountEvent>): number {
  let count = 0;
  let assistantResponseCounted = false;

  for (const event of events) {
    if (event.type === "user-message") {
      count += 1;
      assistantResponseCounted = false;
    } else if (event.type === "text-final" && !assistantResponseCounted) {
      count += 1;
      assistantResponseCounted = true;
    }
  }

  return count;
}

export function messageCountIncrement(
  eventType: string,
  assistantResponseCounted: boolean,
): number {
  if (eventType === "user-message") return 1;
  if (eventType === "text-final" && !assistantResponseCounted) return 1;
  return 0;
}
