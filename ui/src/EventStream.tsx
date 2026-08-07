import { EventView } from './EventView'
import { SubtaskCard } from './SubtaskCard'
import { DebriefCard } from './DebriefCard'
import type { DebriefBlock, StreamBlock } from './groupEvents'
import type { SubtaskStatus } from './types'
import { TestInventoryCard } from './TestInventoryCard'
import type { EventBlock } from './eventBlocks'
import { memo } from 'react'
import type { ReactNode } from 'react'

interface EventStreamProps {
  blocks: StreamBlock[]
  onImageOpen: (src: string, alt: string) => void
  onImageLoad: () => void
  onSubtaskStatusChange?: (subtaskId: string, status: SubtaskStatus | null) => void
  onDebriefQuestion?: (block: DebriefBlock) => void
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
}: EventStreamProps) {
  const rendered: ReactNode[] = []
  let index = 0

  while (index < blocks.length) {
    const block = blocks[index]
    if (block.kind === 'tool') {
      const tools: EventBlock[] = []
      while (index < blocks.length && blocks[index].kind === 'tool') {
        tools.push(blocks[index] as EventBlock)
        index += 1
      }
      const running = tools.some((item) => item.kind === 'tool' && item.output === undefined)
      rendered.push(
        <details className="tool-batch" key={`tool-batch-${tools[0].id}`}>
          <summary>
            <span className="tool-card-chevron" aria-hidden="true" />
            <span>{tools.length} appel{tools.length > 1 ? 's' : ''} shell</span>
            {running ? <span className="tool-card-state">en cours</span> : null}
          </summary>
          <div className="tool-batch-content">
            {tools.map((tool) => (
              <EventView key={tool.id} block={tool} onImageOpen={onImageOpen} onImageLoad={onImageLoad} />
            ))}
          </div>
        </details>,
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
        ) : block.kind === 'test-inventory' ? (
          <TestInventoryCard
            key={block.id}
            block={block}
            onImageOpen={onImageOpen}
            onImageLoad={onImageLoad}
          />
        ) : (
          <EventView
            key={block.id}
            block={block}
            onImageOpen={onImageOpen}
            onImageLoad={onImageLoad}
          />
      ),
    )
    index += 1
  }
  return <>{rendered}</>
}
