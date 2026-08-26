import { useMemo } from 'react'
import { groupEvents, type StreamBlock } from './groupEvents'
import type { AppEvent } from './types'

type GroupableEvent = AppEvent & { id?: number }

interface FrozenPrefix {
  length: number
  lastId: number | undefined
  turnCount: number
  blocks: StreamBlock[]
}

const prefixes = new Map<string, FrozenPrefix>()
const MAX_PREFIXES = 12

function currentTurnStart(events: ReadonlyArray<GroupableEvent>): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'user-message' && !event.steering) return index
  }
  return 0
}

export function useGroupedEvents(
  conversationId: string | null,
  events: ReadonlyArray<GroupableEvent>,
): StreamBlock[] {
  return useMemo(() => {
    const prefixLength = currentTurnStart(events)
    if (conversationId === null || prefixLength === 0) return groupEvents(events)

    const lastId = events[prefixLength - 1]?.id
    let frozen = prefixes.get(conversationId)
    if (frozen?.length !== prefixLength || frozen.lastId !== lastId) {
      const prefix = events.slice(0, prefixLength)
      const turnCount = prefix.reduce((count, event) => (
        event.type === 'user-message' && !event.steering ? count + 1 : count
      ), 0)
      frozen = {
        length: prefixLength,
        lastId,
        turnCount,
        blocks: groupEvents(prefix),
      }
      prefixes.delete(conversationId)
      prefixes.set(conversationId, frozen)
      if (prefixes.size > MAX_PREFIXES) prefixes.delete(prefixes.keys().next().value as string)
    }
    return [...frozen.blocks, ...groupEvents(events.slice(prefixLength), frozen.turnCount)]
  }, [conversationId, events])
}
