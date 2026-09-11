import type { ConversationConfig } from './ConfigPanel'
import type { Attachment } from './types'
import type { TodoFinish, TodoInput } from './todos'

export function buildTodoInput(config: ConversationConfig, draft: { message: string; ticketId: string | null; finish: TodoFinish; attachments: Attachment[] }): TodoInput {
  return {
    provider: config.provider, model: config.model, effort: config.effort,
    speed: config.provider === 'codex' ? config.speed : undefined,
    presetId: config.presetId, permissionMode: config.permissionMode,
    message: draft.message, ticketId: draft.ticketId,
    targetBranch: config.branch?.trim() || null,
    finish: draft.finish,
    attachments: draft.attachments,
    images: draft.attachments.filter((file) => file.mimeType.startsWith('image/')).map((file) => file.name),
  }
}
