import { EventView } from './EventView'
import type { EventBlock } from './EventView'
import { SubtaskCard } from './SubtaskCard'
import type { AppEvent, Provider, SubtaskStatus } from './types'

/** Un `subtask-ref` du fil : une carte de sub-agent, avec son propre flux. */
export interface SubtaskBlock {
  kind: 'subtask'
  id: string
  subtaskId: string
  provider: Provider
  model: string
  label?: string
}

export type StreamBlock = EventBlock | SubtaskBlock

/**
 * Regroupe les événements bruts en blocs affichables. Partagé par le fil d'une
 * conversation et par le transcript déplié d'une sous-tâche : les deux flux ont
 * exactement la même forme (même table d'events côté sidecar).
 */
export function groupEvents(events: AppEvent[]): StreamBlock[] {
  const blocks: StreamBlock[] = []
  const tools = new Map<string, Extract<EventBlock, { kind: 'tool' }>>()
  let assistant: Extract<EventBlock, { kind: 'assistant' }> | null = null
  let turnNumber = 0
  let turnFooter: Extract<EventBlock, { kind: 'turn-footer' }> | null = null

  function ensureTurnFooter() {
    turnFooter ??= {
      kind: 'turn-footer',
      id: `turn-footer-${turnNumber}`,
    }
    return turnFooter
  }

  function flushTurnFooter() {
    if (turnFooter !== null) blocks.push(turnFooter)
    turnFooter = null
  }

  events.forEach((event, index) => {
    switch (event.type) {
      case 'session':
        break

      case 'user-message':
        flushTurnFooter()
        turnNumber += 1
        assistant = null
        blocks.push({
          kind: 'user',
          id: `user-${index}`,
          text: event.text,
          images: event.images,
        })
        break

      case 'text-delta':
        if (assistant === null) {
          assistant = {
            kind: 'assistant',
            id: `assistant-${index}`,
            text: '',
            streaming: true,
          }
          blocks.push(assistant)
        }
        assistant.text += event.text
        assistant.streaming = true
        break

      case 'text-final':
        if (assistant === null) {
          assistant = {
            kind: 'assistant',
            id: `assistant-${index}`,
            text: event.text,
            streaming: false,
          }
          blocks.push(assistant)
        } else {
          assistant.text = event.text
          assistant.streaming = false
        }
        assistant = null
        break

      case 'tool-start': {
        assistant = null
        const tool: Extract<EventBlock, { kind: 'tool' }> = {
          kind: 'tool',
          id: `tool-${event.toolId}`,
          toolId: event.toolId,
          toolName: event.toolName,
          input: event.input,
          images: [],
        }
        tools.set(event.toolId, tool)
        blocks.push(tool)
        break
      }

      case 'tool-end': {
        assistant = null
        const tool = tools.get(event.toolId)
        if (tool !== undefined) {
          tool.output = event.output
          tool.images = event.images
        }
        break
      }

      // Une carte par référence : plusieurs `subtask-ref` consécutifs (fan-out
      // d'un `delegate_parallel`) donnent autant de cartes empilées.
      case 'subtask-ref':
        assistant = null
        blocks.push({
          kind: 'subtask',
          id: `subtask-${event.subtaskId}`,
          subtaskId: event.subtaskId,
          provider: event.provider,
          model: event.model,
          ...(event.label === undefined ? {} : { label: event.label }),
        })
        break

      case 'usage': {
        const footer = ensureTurnFooter()
        footer.usage = {
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
        }
        break
      }

      case 'status':
        ensureTurnFooter().status = event
        if (event.state !== 'running') assistant = null
        break
    }
  })

  flushTurnFooter()
  return blocks
}

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
