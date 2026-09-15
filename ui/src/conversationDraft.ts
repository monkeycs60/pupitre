import type { CreateConversationInput } from './api'
import type { Attachment, ConversationSpeed, GitWorkspaceSelection, PresetPermissionMode, Provider } from './types'

interface ConversationDraft {
  projectId: string
  presetId?: string | null
  provider: Provider
  model: string
  effort: string
  speed: ConversationSpeed
  permissionMode?: PresetPermissionMode | null
  /** Branche saisie par l'utilisateur ; vide = travailler dans le dépôt. */
  branch?: string | null
  repositoryPath?: string | null
  workspaces?: GitWorkspaceSelection[]
  ticketId?: string | null
  originType?: 'sentry' | 'problem' | null
  originKey?: string | null
  problemPlanIndex?: number | null
  problemIds?: string[]
  /** Axes retenus par problématique ; absent = tous les axes. */
  problemPlanIndices?: Record<string, number[]>
  missionTitle?: string
  message: string
  images: string[]
  attachments?: Attachment[]
}

export function newConversationDraftStorageKey(
  projectId: string,
  ticketId?: string | null,
  originType?: 'sentry' | 'problem' | null,
  originKey?: string | null,
  problemPlanIndex?: number | null,
  problemIds?: string[],
): string {
  const scope = problemIds?.length
    ? `new:${projectId}:problems:${[...problemIds].sort().join(',')}`
    : originType && originKey
    ? `new:${projectId}:origin:${originType}:${originKey}${originType === 'problem' ? `:plan:${problemPlanIndex ?? 0}` : ''}`
    : ticketId === null || ticketId === undefined
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
    branch: draft.branch?.trim() || null,
    ...(draft.repositoryPath ? { repositoryPath: draft.repositoryPath } : {}),
    ...(draft.workspaces?.length ? {
      workspaces: draft.workspaces.map(({ branch, repositoryPath }) => ({ branch, repositoryPath })),
    } : {}),
    ticketId: draft.ticketId ?? null,
    ...(draft.originType ? {
      originType: draft.originType,
      originKey: draft.originKey ?? null,
      ...(draft.originType === 'problem' ? { problemPlanIndex: draft.problemPlanIndex ?? null } : {}),
    } : {}),
    ...(draft.problemIds?.length ? {
      problemIds: draft.problemIds,
      problemPlanIndices: draft.problemPlanIndices,
      missionTitle: draft.missionTitle?.trim() || undefined,
    } : {}),
    message: draft.message,
    images: draft.images,
    attachments: draft.attachments ?? [],
  }
}
