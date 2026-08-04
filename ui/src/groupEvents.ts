import type { EventBlock } from './eventBlocks'
import type { AppEvent, Provider } from './types'

export interface SubtaskBlock {
  kind: 'subtask'
  id: string
  subtaskId: string
  provider: Provider
  model: string
  label?: string
}

export type StreamBlock = EventBlock | SubtaskBlock

/** Regroupe les événements bruts d'une conversation en blocs affichables. */
export function groupEvents(events: AppEvent[]): StreamBlock[] {
  const blocks: StreamBlock[] = []
  const tools = new Map<string, Extract<EventBlock, { kind: 'tool' }>>()
  let assistant: Extract<EventBlock, { kind: 'assistant' }> | null = null
  let turnNumber = 0
  let turnFooter: Extract<EventBlock, { kind: 'turn-footer' }> | null = null

  function ensureTurnFooter() {
    turnFooter ??= { kind: 'turn-footer', id: `turn-footer-${turnNumber}` }
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
        blocks.push({ kind: 'user', id: `user-${index}`, text: event.text, images: event.images })
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
          inputTokens: (footer.usage?.inputTokens ?? 0) + event.inputTokens,
          outputTokens: (footer.usage?.outputTokens ?? 0) + event.outputTokens,
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
