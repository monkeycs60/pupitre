import type { CreateConversationInput } from './api'
import type { Attachment, ConversationSpeed, PresetPermissionMode, Provider } from './types'

interface ConversationDraft {
  projectId: string
  provider: Provider
  model: string
  effort: string
  speed: ConversationSpeed
  permissionMode?: PresetPermissionMode | null
  orchestrator: boolean
  subagentPresetId?: string | null
  subagentEffort?: string | null
  message: string
  images: string[]
  attachments?: Attachment[]
}

/** Construit le contrat HTTP depuis le formulaire, sans envoyer fast à Claude. */
export function buildCreateConversationInput(
  draft: ConversationDraft,
): CreateConversationInput {
  return {
    projectId: draft.projectId,
    provider: draft.provider,
    model: draft.model,
    effort: draft.effort,
    speed: draft.provider === 'codex' ? draft.speed : undefined,
    permissionMode: draft.permissionMode ?? null,
    orchestrator: draft.orchestrator,
    subagentPresetId: draft.subagentPresetId ?? null,
    subagentEffort: draft.subagentEffort ?? null,
    message: draft.message,
    images: draft.images,
    attachments: draft.attachments ?? [],
  }
}
