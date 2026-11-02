import { createContext } from 'react'
import { eventIdOfBlock } from './eventBlocks'

/** Messages du fil à montrer : le groupe replié qui en contient un se déplie. */
export const HighlightedEventsContext = createContext<ReadonlySet<number>>(new Set())

/**
 * Le message qui affiche chaque événement cherché. Un texte diffusé par morceaux
 * porte l'identifiant de son premier morceau, pas celui de sa version finale.
 */
export function highlightedBlockEvents(blocks: Array<{ id: string }>, eventIds: number[]): ReadonlySet<number> {
  if (eventIds.length === 0) return new Set()
  const known = blocks.flatMap((block) => eventIdOfBlock(block.id) ?? []).sort((left, right) => left - right)
  return new Set(eventIds.flatMap((id) => known.findLast((candidate) => candidate <= id) ?? []))
}
