import { EventView } from './EventView'
import { SubtaskCard } from './SubtaskCard'
import { ToolActivityGroup } from './ToolActivityGroup'
import { DebriefCard } from './DebriefCard'
import { SessionSummaryCard } from './SessionSummaryCard'
import type { DebriefBlock, StreamBlock } from './groupEvents'
import type { SubtaskStatus } from './types'
import { TestInventoryCard } from './TestInventoryCard'
import { HtmlDocumentCard } from './HtmlDocumentCard'
import { memo } from 'react'
import type { ReactNode } from 'react'
import type { EventBlock } from './eventBlocks'

interface EventStreamProps {
  blocks: StreamBlock[]
  onImageOpen: (src: string, alt: string) => void
  onImageLoad: () => void
  onSubtaskStatusChange?: (subtaskId: string, status: SubtaskStatus | null) => void
  onDebriefQuestion?: (block: DebriefBlock) => void
  turnFooterAction?: ReactNode
  conversationId?: string
}

/**
 * Rendu d'une liste de blocs. `EventView` couvre les blocs simples ; les blocs
 * `subtask` deviennent des cartes qui, dépliées, re-rendent ce même composant
 * sur le flux de la sous-tâche (récursion volontaire).
 */
export const EventStream = memo(EventStreamImpl)

function EventStreamImpl({
  blocks,
  onImageOpen,
  onImageLoad,
  onSubtaskStatusChange,
  onDebriefQuestion,
  turnFooterAction,
}: EventStreamProps) {
  const rendered: ReactNode[] = []
  const newestHtmlDocumentId = blocks.findLast((item) => item.kind === 'html-document')?.id
  const newestTurnFooter = blocks.findLast((item) => item.kind === 'turn-footer')
  const newestTurnFooterId = newestTurnFooter?.id
  const liveFrom = newestTurnFooter?.kind === 'turn-footer' && newestTurnFooter.status?.state === 'running'
    ? blocks.findLastIndex((item) => item.kind === 'user')
    : blocks.length
  const lastBlock = blocks.findLast((item) => item.kind !== 'turn-footer')
  const liveReasoningId = liveFrom < blocks.length && lastBlock?.kind === 'reasoning' ? lastBlock.id : undefined
  let index = 0

  while (index < blocks.length) {
    const block = blocks[index]
    if (block.kind === 'tool') {
      const live = index > liveFrom
      const tools: Array<Extract<EventBlock, { kind: 'tool' }>> = []
      while (index < blocks.length && blocks[index].kind === 'tool') {
        tools.push(blocks[index] as Extract<EventBlock, { kind: 'tool' }>)
        index += 1
      }
      rendered.push(
        <ToolActivityGroup key={`tool-activity-group-${tools[0].id}`} tools={tools} live={live} onImageOpen={onImageOpen} onImageLoad={onImageLoad} />,
      )
      continue
    }
    rendered.push(
      block.kind === 'subtask' ? (
          <SubtaskCard
            key={block.id}
            block={block}
            onImageOpen={onImageOpen}
            onImageLoad={onImageLoad}
            onStatusChange={onSubtaskStatusChange}
          />
        ) : block.kind === 'debrief' ? (
          <DebriefCard key={block.id} block={block} onQuestion={onDebriefQuestion} />
        ) : block.kind === 'session-summary' ? (
          <SessionSummaryCard key={block.id} block={block} />
        ) : block.kind === 'test-inventory' ? (
          <TestInventoryCard
            key={block.id}
            block={block}
            onImageOpen={onImageOpen}
            onImageLoad={onImageLoad}
          />
        ) : block.kind === 'html-document' ? (
          <HtmlDocumentCard
            key={block.id}
            block={block}
            defaultOpen={block.id === newestHtmlDocumentId}
          />
        ) : (
          <EventView
            key={block.id}
            block={block}
            live={block.id === liveReasoningId}
            onImageOpen={onImageOpen}
            onImageLoad={onImageLoad}
            turnFooterAction={block.id === newestTurnFooterId ? turnFooterAction : undefined}
          />
      ),
    )
    index += 1
  }
  return <>{rendered}</>
}
