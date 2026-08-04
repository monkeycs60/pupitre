import type { StoredEvent } from './types'

// Raccord replay/WS : le socket est ouvert AVANT le fetch du replay, donc le
// buffer peut recouvrir la fin du replay (doublons) ou le dépasser (événements
// que le replay n'avait pas encore). Le replay est autoritaire jusqu'à son plus
// grand id : une compaction DB peut avoir supprimé des deltas déjà vus en live.
export function mergeReplayAndBuffer(
  replay: StoredEvent[],
  buffer: StoredEvent[],
): StoredEvent[] {
  const byId = new Map<number, StoredEvent>()
  const replayWatermark = replay.reduce(
    (highest, event) => Math.max(highest, event.id),
    Number.NEGATIVE_INFINITY,
  )
  for (const event of buffer) {
    if (event.id > replayWatermark) byId.set(event.id, event)
  }
  for (const event of replay) byId.set(event.id, event)
  return [...byId.values()].sort((a, b) => a.id - b.id)
}
