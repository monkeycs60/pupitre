import { EventView } from './EventView'
import { SubtaskCard } from './SubtaskCard'
import type { StreamBlock } from './groupEvents'
import type { SubtaskStatus } from './types'

interface EventStreamProps {
  blocks: StreamBlock[]
  onImageOpen: (src: string, alt: string) => void
  onImageLoad: () => void
  onSubtaskStatusChange?: (subtaskId: string, status: SubtaskStatus | null) => void
}

/**
 * Rendu d'une liste de blocs. `EventView` couvre les blocs simples ; les blocs
 * `subtask` deviennent des cartes qui, dépliées, re-rendent ce même composant
 * sur le flux de la sous-tâche (récursion volontaire).
 */
export function EventStream({
  blocks,
  onImageOpen,
  onImageLoad,
  onSubtaskStatusChange,
}: EventStreamProps) {
  return (
    <>
      {blocks.map((block) =>
        block.kind === 'subtask' ? (
          <SubtaskCard
            key={block.id}
            block={block}
            onImageOpen={onImageOpen}
            onImageLoad={onImageLoad}
            onStatusChange={onSubtaskStatusChange}
          />
        ) : (
          <EventView
            key={block.id}
            block={block}
            onImageOpen={onImageOpen}
            onImageLoad={onImageLoad}
          />
        ),
      )}
    </>
  )
}
