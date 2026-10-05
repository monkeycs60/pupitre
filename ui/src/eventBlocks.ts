import type { AppEvent, Attachment } from './types'

interface UserBlock {
  kind: 'user'
  id: string
  text: string
  images: string[]
  attachments: Attachment[]
  steering?: boolean
  queued?: boolean
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
  isError?: boolean
  images: string[]
}

interface ReasoningBlock {
  kind: 'reasoning'
  id: string
  text: string
}

interface BackgroundTaskBlock {
  kind: 'background-task'
  id: string
  tasks: Array<{ status: string; summary: string }>
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
  activity?: 'thinking' | 'writing' | 'tool'
  phase?: string
  files?: Array<{ path: string; added: number; removed: number }>
  /**
   * Nombre de sous-tâches réellement lancées pendant ce tour. Absent quand il
   * n'y en a eu aucune. Un modèle peut affirmer avoir délégué sans l'avoir
   * fait : ce compte vient des événements, pas de sa réponse.
   */
  subtaskCount?: number
  /** Présent quand l'agent a ouvert le tour sans message de l'utilisateur. */
  origin?: 'agent' | 'background-task'
}

export type EventBlock =
  | UserBlock
  | AssistantBlock
  | ToolBlock
  | ReasoningBlock
  | BackgroundTaskBlock
  | TurnFooterBlock

export function eventIdOfBlock(id: string): number | undefined {
  const match = /^(?:user|assistant|html-document)-(\d+)(?:-|$)/.exec(id)
  return match ? Number(match[1]) : undefined
}
