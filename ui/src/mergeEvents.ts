import type { StoredEvent } from './types'

// Raccord replay/WS : le socket est ouvert AVANT le fetch du replay, donc le
// buffer peut recouvrir la fin du replay (doublons) ou le dépasser (événements
// que le replay n'avait pas encore). Dédup par id, replay prioritaire.
export function mergeReplayAndBuffer(
  replay: StoredEvent[],
  buffer: StoredEvent[],
): StoredEvent[] {
  const byId = new Map<number, StoredEvent>()
  for (const event of buffer) byId.set(event.id, event)
  for (const event of replay) byId.set(event.id, event)
  return [...byId.values()].sort((a, b) => a.id - b.id)
}
