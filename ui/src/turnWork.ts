import type { EventBlock } from './eventBlocks'
import type { StreamBlock } from './groupEvents'

type ToolBlock = Extract<EventBlock, { kind: 'tool' }>

type TurnFooterBlock = Extract<StreamBlock, { kind: 'turn-footer' }>

export interface TurnWorkBlock {
  kind: 'turn-work'
  id: string
  blocks: StreamBlock[]
  durationMs?: number
  live?: Pick<TurnFooterBlock, 'activity' | 'phase' | 'timing'>
}

const WORK_KINDS = new Set<StreamBlock['kind']>(['tool', 'reasoning', 'assistant', 'background-task'])
const ACTIVITY_KINDS = new Set<StreamBlock['kind']>(['tool', 'reasoning', 'background-task'])

/**
 * Replie chaque tour terminé, et le tour en cours, sur une seule ligne :
 * appels d'outils, raisonnement et messages intermédiaires. La réponse finale
 * est la suite de blocs `assistant` qui suit la dernière activité du tour.
 * Un tour terminé sans elle (interrompu ou en échec) reste déplié. Les
 * messages de l'utilisateur et les livrables (documents, sous-tâches…)
 * restent visibles. La ligne du tour en cours porte la même clé que celle du
 * tour terminé : elle se transforme sur place au lieu d'être remplacée.
 */
export function foldTurns(blocks: StreamBlock[]): Array<StreamBlock | TurnWorkBlock> {
  const result: Array<StreamBlock | TurnWorkBlock> = []
  const newestFooterIndex = blocks.findLastIndex((block) => block.kind === 'turn-footer')
  let start = 0
  blocks.forEach((block, index) => {
    if (block.kind !== 'turn-footer') return
    const state = block.status?.state
    const live = index === newestFooterIndex && state === 'running'
    const finished = index < newestFooterIndex ? state !== 'running' : state === 'done' || state === 'error'
    if (!live && !finished) return
    result.push(...foldTurn(blocks.slice(start, index), block, live), block)
    start = index + 1
  })
  result.push(...blocks.slice(start))
  return result
}

function turnDuration(footer: TurnFooterBlock): number | undefined {
  const startedAt = Date.parse(footer.timing?.startedAt ?? '')
  const completedAt = Date.parse(footer.timing?.completedAt ?? '')
  return Number.isFinite(startedAt) && Number.isFinite(completedAt) && completedAt >= startedAt
    ? completedAt - startedAt
    : undefined
}

function foldTurn(turn: StreamBlock[], footer: TurnFooterBlock, live: boolean): Array<StreamBlock | TurnWorkBlock> {
  const durationMs = turnDuration(footer)
  const lastActivity = turn.findLastIndex((block) => ACTIVITY_KINDS.has(block.kind))
  const answered = turn.slice(lastActivity + 1).some((block) => block.kind === 'assistant')
  if (!live && (!answered || (lastActivity === -1 && durationMs === undefined))) return turn
  const firstWork = turn.findIndex((block) => WORK_KINDS.has(block.kind))
  const at = firstWork === -1 ? turn.length : firstWork
  const end = lastActivity === -1 ? at : lastActivity + 1
  const range = turn.slice(at, end)
  return [
    ...turn.slice(0, at),
    {
      kind: 'turn-work',
      id: `turn-work-${footer.id}`,
      blocks: range.filter((block) => WORK_KINDS.has(block.kind)),
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(live ? { live: { activity: footer.activity, phase: footer.phase, timing: footer.timing } } : {}),
    },
    ...range.filter((block) => !WORK_KINDS.has(block.kind)),
    ...turn.slice(end),
  ]
}

export function turnWorkTools(work: TurnWorkBlock): ToolBlock[] {
  return work.blocks.filter((block): block is ToolBlock => block.kind === 'tool')
}

export function turnWorkNoteCount(work: TurnWorkBlock): number {
  return work.blocks.filter((block) => block.kind === 'assistant' && block.text.trim() !== '').length
}
