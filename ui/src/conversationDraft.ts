import type { CreateConversationInput } from './api'
import type { ConversationSpeed, Provider } from './types'

interface ConversationDraft {
  projectId: string
  provider: Provider
  model: string
  effort: string
  speed: ConversationSpeed
  orchestrator: boolean
  message: string
  images: string[]
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
    orchestrator: draft.orchestrator,
    message: draft.message,
    images: draft.images,
  }
}
