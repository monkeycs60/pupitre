import type { ConversationConfig } from './ConfigPanel'
import type { Attachment } from './types'
import type { TodoInput } from './todos'

export interface TodoDraftSeed {
  message: string
  attachments: Attachment[]
  config: ConversationConfig
  ticketId: string | null
}

export function buildTodoInput(config: ConversationConfig, draft: { message: string; ticketId: string | null; integrate: boolean; autonomy: 'local' | 'investigate'; checks: string; attachments: Attachment[] }): TodoInput {
  return {
    provider: config.provider, model: config.model, effort: config.effort,
    speed: config.provider === 'codex' ? config.speed : undefined,
    presetId: config.presetId, permissionMode: config.permissionMode,
    message: draft.message, ticketId: draft.ticketId,
    targetBranch: config.branch?.trim() || null,
    integrate: draft.autonomy === 'local' && draft.integrate,
    autonomy: draft.autonomy,
    checks: draft.checks.split('\n').map((line) => line.trim()).filter(Boolean),
    attachments: draft.attachments,
    images: draft.attachments.filter((file) => file.mimeType.startsWith('image/')).map((file) => file.name),
  }
}
