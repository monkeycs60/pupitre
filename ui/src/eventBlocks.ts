import type { AppEvent, Attachment } from './types'

interface UserBlock {
  kind: 'user'
  id: string
  text: string
  images: string[]
  attachments: Attachment[]
}

interface AssistantBlock {
  kind: 'assistant'
  id: string
  text: string
  streaming: boolean
}

interface ToolBlock {
  kind: 'tool'
  id: string
  toolId: string
  toolName: string
  input: unknown
  output?: string
  images: string[]
}

interface TurnFooterBlock {
  kind: 'turn-footer'
  id: string
  usage?: {
    inputTokens: number
    outputTokens: number
  }
  status?: Extract<AppEvent, { type: 'status' }>
  timing?: {
    startedAt: string
    firstResponseAt?: string
    completedAt?: string
  }
  files?: Array<{ path: string; added: number; removed: number }>
  /**
   * Nombre de sous-tâches réellement lancées pendant ce tour. Absent quand il
   * n'y en a eu aucune. Un modèle peut affirmer avoir délégué sans l'avoir
   * fait : ce compte vient des événements, pas de sa réponse.
   */
  subtaskCount?: number
}

export type EventBlock =
  | UserBlock
  | AssistantBlock
  | ToolBlock
  | TurnFooterBlock
