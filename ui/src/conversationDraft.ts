import type { CreateConversationInput } from './api'
import type { Attachment, ConversationSpeed, PresetPermissionMode, Provider } from './types'

interface ConversationDraft {
  projectId: string
  presetId?: string | null
  provider: Provider
  model: string
  effort: string
  speed: ConversationSpeed
  permissionMode?: PresetPermissionMode | null
  orchestrator: boolean
  subagentPresetId?: string | null
  subagentEffort?: string | null
  /** Branche saisie par l'utilisateur ; vide = travailler dans le dépôt. */
  branch?: string | null
  ticketId?: string | null
  message: string
  images: string[]
  attachments?: Attachment[]
}

export function newConversationDraftStorageKey(
  projectId: string,
  ticketId?: string | null,
): string {
  const scope = ticketId === null || ticketId === undefined
    ? `new:${projectId}`
    : `new:${projectId}:ticket:${ticketId}`
  return `pupitre:draft:${scope}`
}

/** Construit le contrat HTTP depuis le formulaire, sans envoyer fast à Claude. */
export function buildCreateConversationInput(
  draft: ConversationDraft,
): CreateConversationInput {
  return {
    projectId: draft.projectId,
    presetId: draft.presetId ?? null,
    provider: draft.provider,
    model: draft.model,
    effort: draft.effort,
    speed: draft.provider === 'codex' ? draft.speed : undefined,
    permissionMode: draft.permissionMode ?? null,
    orchestrator: draft.orchestrator,
    subagentPresetId: draft.subagentPresetId ?? null,
    subagentEffort: draft.subagentEffort ?? null,
    branch: draft.branch?.trim() || null,
    ticketId: draft.ticketId ?? null,
    message: draft.message,
    images: draft.images,
    attachments: draft.attachments ?? [],
  }
}
