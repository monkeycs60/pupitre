import type { EventBlock } from './eventBlocks'
import type { AppEvent, Provider, TestScope } from './types'

export interface SubtaskBlock {
  kind: 'subtask'
  id: string
  subtaskId: string
  provider: Provider
  model: string
  label?: string
}

export interface DebriefBlock {
  kind: 'debrief'
  id: string
  debriefId: string
  eventIdFrom: number
  eventIdTo: number
  contentMd: string
  createdAt: string
}

export interface SessionSummaryBlock {
  kind: 'session-summary'
  id: string
  summaryId: string
  eventIdFrom: number
  eventIdTo: number
  contentMd: string
  createdAt: string
}

export interface TestInventoryBlock {
  kind: 'test-inventory'
  id: string
  inventoryId: string
  scopes: TestScope[]
  createdAt: string
}

export type StreamBlock =
  | EventBlock
  | SubtaskBlock
  | DebriefBlock
  | SessionSummaryBlock
  | TestInventoryBlock

function lineCount(text: string): number {
  return text.length === 0 ? 0 : text.split('\n').length
}

/** Extrait le delta de lignes (ajouts/suppressions) d'un tool call d'édition de fichier, si reconnu. */
function fileEditFromTool(
  toolName: string,
  input: unknown,
): { path: string; added: number; removed: number } | null {
  if (input === null || typeof input !== 'object') return null
  const record = input as Record<string, unknown>

  switch (toolName) {
    case 'Edit': {
      const filePath = record.file_path
      const oldString = record.old_string
      const newString = record.new_string
      if (typeof filePath !== 'string' || typeof oldString !== 'string' || typeof newString !== 'string') {
        return null
      }
      return { path: filePath, added: lineCount(newString), removed: lineCount(oldString) }
    }
    case 'Write': {
      const filePath = record.file_path
      const content = record.content
      if (typeof filePath !== 'string' || typeof content !== 'string') return null
      return { path: filePath, added: lineCount(content), removed: 0 }
    }
    case 'MultiEdit': {
      const filePath = record.file_path
      const edits = record.edits
      if (typeof filePath !== 'string' || !Array.isArray(edits)) return null
      let added = 0
      let removed = 0
      for (const edit of edits) {
        if (edit === null || typeof edit !== 'object') continue
        const { old_string: oldString, new_string: newString } = edit as Record<string, unknown>
        if (typeof oldString === 'string') removed += lineCount(oldString)
        if (typeof newString === 'string') added += lineCount(newString)
      }
      return { path: filePath, added, removed }
    }
    case 'NotebookEdit': {
      const notebookPath = record.notebook_path
      if (typeof notebookPath !== 'string') return null
      return { path: notebookPath, added: 0, removed: 0 }
    }
    default:
      return null
  }
}

export function guardianAckCount(events: ReadonlyArray<AppEvent>): number {
  return events.reduce(
    (count, event) => event.type === 'test-scope-result'
      ? count + (event.guardianFlagIdsAcked?.length ?? 0)
      : count,
    0,
  )
}

/** Regroupe les événements bruts d'une conversation en blocs affichables. */
export function groupEvents(events: ReadonlyArray<AppEvent & { id?: number }>): StreamBlock[] {
  const blocks: StreamBlock[] = []
  const tools = new Map<string, Extract<EventBlock, { kind: 'tool' }>>()
  const testInventories = new Map<string, TestInventoryBlock>()
  let assistant: Extract<EventBlock, { kind: 'assistant' }> | null = null
  let turnNumber = 0
  let turnFooter: Extract<EventBlock, { kind: 'turn-footer' }> | null = null
  let turnFiles = new Map<string, { added: number; removed: number }>()

  function ensureTurnFooter() {
    turnFooter ??= { kind: 'turn-footer', id: `turn-footer-${turnNumber}` }
    return turnFooter
  }

  function flushTurnFooter() {
    if (turnFooter !== null) blocks.push(turnFooter)
    turnFooter = null
  }

  events.forEach((event, index) => {
    const eventKey = event.id ?? index
    switch (event.type) {
      case 'session':
        break
      case 'user-message':
        flushTurnFooter()
        turnNumber += 1
        turnFiles = new Map()
        assistant = null
        blocks.push({
          kind: 'user',
          id: `user-${eventKey}`,
          text: event.text,
          images: event.images,
          attachments: event.attachments ?? [],
        })
        break
      case 'text-delta':
        if (assistant === null) {
          assistant = {
            kind: 'assistant',
            id: `assistant-${eventKey}`,
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
            id: `assistant-${eventKey}`,
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
          id: `tool-${eventKey}-${event.toolId}`,
          toolId: event.toolId,
          toolName: event.toolName,
          input: event.input,
          images: [],
        }
        tools.set(event.toolId, tool)
        blocks.push(tool)
        const fileEdit = fileEditFromTool(event.toolName, event.input)
        if (fileEdit !== null) {
          const existing = turnFiles.get(fileEdit.path) ?? { added: 0, removed: 0 }
          turnFiles.set(fileEdit.path, {
            added: existing.added + fileEdit.added,
            removed: existing.removed + fileEdit.removed,
          })
          ensureTurnFooter().files = Array.from(turnFiles, ([path, delta]) => ({ path, ...delta }))
        }
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
          id: `subtask-${eventKey}-${event.subtaskId}`,
          subtaskId: event.subtaskId,
          provider: event.provider,
          model: event.model,
          ...(event.label === undefined ? {} : { label: event.label }),
        })
        break
      case 'debrief-ref':
        assistant = null
        blocks.push({
          kind: 'debrief',
          id: `debrief-${eventKey}-${event.debriefId}`,
          debriefId: event.debriefId,
          eventIdFrom: event.eventIdFrom,
          eventIdTo: event.eventIdTo,
          contentMd: event.contentMd,
          createdAt: event.createdAt,
        })
        break
      case 'session-summary-ref':
        assistant = null
        blocks.push({
          kind: 'session-summary',
          id: `session-summary-${eventKey}-${event.summaryId}`,
          summaryId: event.summaryId,
          eventIdFrom: event.eventIdFrom,
          eventIdTo: event.eventIdTo,
          contentMd: event.contentMd,
          createdAt: event.createdAt,
        })
        break
      case 'test-inventory-ref': {
        assistant = null
        const inventory: TestInventoryBlock = {
          kind: 'test-inventory',
          id: `test-inventory-${eventKey}-${event.inventoryId}`,
          inventoryId: event.inventoryId,
          scopes: event.scopes.map((scope) => ({
            ...scope,
            images: scope.images ?? [],
          })),
          createdAt: event.createdAt,
        }
        testInventories.set(event.inventoryId, inventory)
        blocks.push(inventory)
        break
      }
      case 'test-scope-started': {
        const inventory = testInventories.get(event.inventoryId)
        const scope = inventory?.scopes.find((item) => item.id === event.scopeId)
        if (scope) {
          scope.status = 'running'
          scope.subtaskId = event.subtaskId
          scope.evidenceMd = null
          scope.error = null
        }
        break
      }
      case 'test-scope-result': {
        const inventory = testInventories.get(event.inventoryId)
        const scope = inventory?.scopes.find((item) => item.id === event.scopeId)
        if (scope) {
          scope.status = event.status
          scope.evidenceMd = event.evidenceMd
          scope.images = event.images ?? []
          scope.guardianFlagIdsAcked = event.guardianFlagIdsAcked ?? []
          scope.error = event.error ?? null
        }
        break
      }
      case 'usage': {
        const footer = ensureTurnFooter()
        footer.usage = {
          inputTokens: (footer.usage?.inputTokens ?? 0) + event.inputTokens,
          outputTokens: (footer.usage?.outputTokens ?? 0) + event.outputTokens,
        }
        break
      }
      case 'turn-timing': {
        const footer = ensureTurnFooter()
        footer.timing = {
          startedAt: event.startedAt,
          ...(event.firstResponseAt === undefined
            ? {}
            : { firstResponseAt: event.firstResponseAt }),
          ...(event.completedAt === undefined
            ? {}
            : { completedAt: event.completedAt }),
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
