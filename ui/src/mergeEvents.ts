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

// Chemin chaud du flux live : le cas normal est un événement plus récent que
// tout l'existant, qui s'appende sans reconstruire ni re-trier le fil — la
// fusion complète ci-dessus, O(N log N), re-triait toute la conversation à
// chaque delta. Elle reste le filet des arrivées dans le désordre.
export function appendLiveEvent(
  current: StoredEvent[],
  event: StoredEvent,
): StoredEvent[] {
  const last = current[current.length - 1]
  if (last === undefined || event.id > last.id) return [...current, event]
  return mergeReplayAndBuffer(current, [event])
}
