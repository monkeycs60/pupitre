import type { EventBlock } from './eventBlocks'
import type { StreamBlock } from './groupEvents'

type ToolBlock = Extract<EventBlock, { kind: 'tool' }>

export interface TurnWorkBlock {
  kind: 'turn-work'
  id: string
  blocks: StreamBlock[]
  durationMs?: number
}

const WORK_KINDS = new Set<StreamBlock['kind']>(['tool', 'reasoning', 'assistant', 'background-task'])
const ACTIVITY_KINDS = new Set<StreamBlock['kind']>(['tool', 'reasoning', 'background-task'])

/**
 * Replie, dans chaque tour terminé, tout ce qui précède la réponse finale :
 * appels d'outils, raisonnement et messages intermédiaires. La réponse finale
 * est la suite de blocs `assistant` qui suit la dernière activité du tour ;
 * sans elle (tour interrompu ou en échec), le tour reste déplié. Les messages
 * de l'utilisateur et les livrables (documents, sous-tâches…) restent visibles.
 */
export function foldFinishedTurns(blocks: StreamBlock[]): Array<StreamBlock | TurnWorkBlock> {
  const result: Array<StreamBlock | TurnWorkBlock> = []
  const newestFooterIndex = blocks.findLastIndex((block) => block.kind === 'turn-footer')
  let start = 0
  blocks.forEach((block, index) => {
    if (block.kind !== 'turn-footer') return
    const state = block.status?.state
    const finished = index < newestFooterIndex ? state !== 'running' : state === 'done' || state === 'error'
    if (!finished) return
    result.push(...foldTurn(blocks.slice(start, index), turnDuration(block)), block)
    start = index + 1
  })
  result.push(...blocks.slice(start))
  return result
}

function turnDuration(footer: Extract<StreamBlock, { kind: 'turn-footer' }>): number | undefined {
  const startedAt = Date.parse(footer.timing?.startedAt ?? '')
  const completedAt = Date.parse(footer.timing?.completedAt ?? '')
  return Number.isFinite(startedAt) && Number.isFinite(completedAt) && completedAt >= startedAt
    ? completedAt - startedAt
    : undefined
}

function foldTurn(turn: StreamBlock[], durationMs: number | undefined): Array<StreamBlock | TurnWorkBlock> {
  const lastActivity = turn.findLastIndex((block) => ACTIVITY_KINDS.has(block.kind))
  if (lastActivity === -1) return turn
  if (!turn.slice(lastActivity + 1).some((block) => block.kind === 'assistant')) return turn
  const firstWork = turn.findIndex((block) => WORK_KINDS.has(block.kind))
  const range = turn.slice(firstWork, lastActivity + 1)
  const work = range.filter((block) => WORK_KINDS.has(block.kind))
  return [
    ...turn.slice(0, firstWork),
    { kind: 'turn-work', id: `turn-work-${work[0].id}`, blocks: work, ...(durationMs === undefined ? {} : { durationMs }) },
    ...range.filter((block) => !WORK_KINDS.has(block.kind)),
    ...turn.slice(lastActivity + 1),
  ]
}

export function turnWorkTools(work: TurnWorkBlock): ToolBlock[] {
  return work.blocks.filter((block): block is ToolBlock => block.kind === 'tool')
}

export function turnWorkNoteCount(work: TurnWorkBlock): number {
  return work.blocks.filter((block) => block.kind === 'assistant' && block.text.trim() !== '').length
}
