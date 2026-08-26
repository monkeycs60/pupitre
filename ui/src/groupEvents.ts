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

export interface HtmlDocumentBlock {
  kind: 'html-document'
  id: string
  documentId: string
  title: string
  summary?: string
  documentKind?: 'html' | 'pdf'
  mimeType?: string
  originalName?: string
  sizeBytes: number
  createdAt: string
  expiresAt: string | null
}

export interface ReviewReportBlock {
  kind: 'review-report'
  id: string
  reviewId: string
  createdAt: string
}

export type StreamBlock =
  | EventBlock
  | SubtaskBlock
  | DebriefBlock
  | SessionSummaryBlock
  | TestInventoryBlock
  | HtmlDocumentBlock
  | ReviewReportBlock

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

/**
 * Parse un ou plusieurs blocs `apply_patch` (format Codex) trouvés dans le
 * texte d'une commande shell. Ignore silencieusement le texte s'il ne
 * contient aucun `*** Begin Patch` : on ne devine jamais de fichiers à partir
 * d'une commande shell arbitraire.
 */
export function parseApplyPatch(command: string): Array<{ path: string; added: number; removed: number }> {
  if (!command.includes('*** Begin Patch')) return []

  const totals = new Map<string, { added: number; removed: number }>()
  let currentPath: string | null = null
  let inPatch = false

  const bump = (path: string, added: number, removed: number) => {
    const existing = totals.get(path) ?? { added: 0, removed: 0 }
    totals.set(path, { added: existing.added + added, removed: existing.removed + removed })
  }

  for (const line of command.split('\n')) {
    if (line.startsWith('*** Begin Patch')) {
      inPatch = true
      currentPath = null
      continue
    }
    if (line.startsWith('*** End Patch')) {
      inPatch = false
      currentPath = null
      continue
    }
    if (!inPatch) continue

    const updateMatch = /^\*\*\* Update File: (.+)$/.exec(line)
    const addMatch = /^\*\*\* Add File: (.+)$/.exec(line)
    const deleteMatch = /^\*\*\* Delete File: (.+)$/.exec(line)
    if (updateMatch || addMatch || deleteMatch) {
      const path = (updateMatch ?? addMatch ?? deleteMatch)![1].trim()
      currentPath = path
      if (!totals.has(path)) totals.set(path, { added: 0, removed: 0 })
      continue
    }
    if (line.startsWith('*** ')) {
      // Autre marqueur (Move to, End of File, etc.) : pas un fichier suivi.
      continue
    }
    if (currentPath === null) continue

    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) bump(currentPath, 1, 0)
    else if (line.startsWith('-')) bump(currentPath, 0, 1)
  }

  return Array.from(totals, ([path, delta]) => ({ path, ...delta }))
}

/** Types d'action `commandExecution` de Codex qui ne modifient pas le fichier :
 *  ils ne doivent pas produire de chip d'édition. */
const READ_ONLY_CODEX_ACTIONS = new Set(['read', 'list', 'search'])

/** Fichiers édités par un outil `shell`.
 *  Deux sources réelles, sans rien inventer :
 *  1. un `apply_patch` en heredoc dans la commande bash (chemins + deltas exacts) ;
 *  2. les `commandActions` structurées de Codex app-server (type + path), dont on
 *     retient tout ce qui n'est pas une lecture — sans compte de lignes fiable. */
function shellApplyPatchEdits(
  toolName: string,
  input: unknown,
): Array<{ path: string; added: number; removed: number }> {
  if (toolName !== 'shell') return []
  if (input === null || typeof input !== 'object') return []
  const record = input as Record<string, unknown>
  const edits: Array<{ path: string; added: number; removed: number }> = []

  if (typeof record.command === 'string') {
    edits.push(...parseApplyPatch(record.command))
  }

  if (Array.isArray(record.actions)) {
    for (const raw of record.actions) {
      if (raw === null || typeof raw !== 'object') continue
      const action = raw as Record<string, unknown>
      const path = action.path
      const type = typeof action.type === 'string' ? action.type : ''
      if (typeof path !== 'string' || READ_ONLY_CODEX_ACTIONS.has(type)) continue
      edits.push({ path, added: 0, removed: 0 })
    }
  }

  return edits
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
export function groupEvents(
  events: ReadonlyArray<AppEvent & { id?: number }>,
  initialTurnNumber = 0,
): StreamBlock[] {
  const blocks: StreamBlock[] = []
  const tools = new Map<string, Extract<EventBlock, { kind: 'tool' }>>()
  const testInventories = new Map<string, TestInventoryBlock>()
  let assistant: Extract<EventBlock, { kind: 'assistant' }> | null = null
  let turnNumber = initialTurnNumber
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
        if (!event.steering) {
          flushTurnFooter()
          turnNumber += 1
          turnFiles = new Map()
        }
        assistant = null
        blocks.push({
          kind: 'user',
          id: `user-${eventKey}`,
          text: event.text,
          images: event.images,
          attachments: event.attachments ?? [],
          ...(event.steering ? { steering: true } : {}),
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
        const fileEdits = fileEdit !== null ? [fileEdit] : shellApplyPatchEdits(event.toolName, event.input)
        if (fileEdits.length > 0) {
          for (const edit of fileEdits) {
            const existing = turnFiles.get(edit.path) ?? { added: 0, removed: 0 }
            turnFiles.set(edit.path, {
              added: existing.added + edit.added,
              removed: existing.removed + edit.removed,
            })
          }
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
      case 'subtask-ref': {
        assistant = null
        const footer = ensureTurnFooter()
        footer.subtaskCount = (footer.subtaskCount ?? 0) + 1
        blocks.push({
          kind: 'subtask',
          id: `subtask-${eventKey}-${event.subtaskId}`,
          subtaskId: event.subtaskId,
          provider: event.provider,
          model: event.model,
          ...(event.label === undefined ? {} : { label: event.label }),
        })
        break
      }
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
      case 'html-document-ref':
      case 'document-ref':
        assistant = null
        blocks.push({
          kind: 'html-document',
          id: `html-document-${eventKey}-${event.documentId}`,
          documentId: event.documentId,
          title: event.title,
          ...(event.summary === undefined ? {} : { summary: event.summary }),
          ...(event.type === 'document-ref' ? {
            documentKind: event.kind,
            mimeType: event.mimeType,
            originalName: event.originalName,
          } : {}),
          sizeBytes: event.sizeBytes,
          createdAt: event.createdAt,
          expiresAt: event.expiresAt,
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
      case 'review-report-ref':
        assistant = null
        blocks.push({
          kind: 'review-report',
          id: `review-report-${eventKey}-${event.reviewId}`,
          reviewId: event.reviewId,
          createdAt: event.createdAt,
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
