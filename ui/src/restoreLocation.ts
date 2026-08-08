import type { Conversation, Project } from './types'

export const LAST_ACTIVE_LOCATION_STORAGE_KEY = 'pupitre.last-active-location'

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface LastActiveLocation {
  projectId: string
  conversationId: string | null
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function readLastActiveLocation(storage: StorageLike): LastActiveLocation | null {
  try {
    const raw = storage.getItem(LAST_ACTIVE_LOCATION_STORAGE_KEY)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null
    }
    const value = parsed as Record<string, unknown>
    if (!nonEmptyString(value.projectId)) return null
    if (value.conversationId !== null && !nonEmptyString(value.conversationId)) {
      return null
    }
    return {
      projectId: value.projectId,
      conversationId: value.conversationId as string | null,
    }
  } catch {
    return null
  }
}

export function writeLastActiveLocation(
  storage: StorageLike,
  location: LastActiveLocation,
): void {
  try {
    storage.setItem(LAST_ACTIVE_LOCATION_STORAGE_KEY, JSON.stringify(location))
  } catch {
    // Un stockage local indisponible ne doit pas bloquer l'interface.
  }
}

export function restoreProject(
  projects: readonly Project[],
  location: LastActiveLocation | null,
): Project | null {
  if (location === null) return null
  return projects.find((project) => project.id === location.projectId) ?? projects[0] ?? null
}

export function restoreConversation(
  conversations: readonly Conversation[],
  conversationId: string | null,
): Conversation | null {
  if (conversationId !== null) {
    const remembered = conversations.find((conversation) => conversation.id === conversationId)
    if (remembered !== undefined) return remembered
  }
  return conversations.reduce<Conversation | null>((newest, conversation) => {
    if (newest === null || conversation.updated_at > newest.updated_at) return conversation
    return newest
  }, null)
}
