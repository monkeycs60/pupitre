import type { Conversation, ViewedConversation } from './types'

export const RECENT_LIMIT = 8

export function visitOf(conversation: Conversation, projectName: string, at: string): ViewedConversation {
  return {
    id: conversation.id,
    project_id: conversation.project_id,
    project_name: projectName,
    title: conversation.title,
    summary: conversation.summary,
    provider: conversation.provider,
    model: conversation.model,
    answered_turn: conversation.answered_turn ?? 0,
    last_read_turn: conversation.last_read_turn ?? 0,
    updated_at: conversation.updated_at,
    viewed_at: at,
  }
}

export function mergeRecentConversations(
  viewed: ViewedConversation[],
  pinned: ViewedConversation | null,
  currentId: string | null | undefined,
  limit = RECENT_LIMIT,
): ViewedConversation[] {
  const stored = pinned === null ? undefined : viewed.find((item) => item.id === pinned.id)
  const head = pinned === null || pinned.id === currentId
    ? []
    : [stored ? { ...stored, viewed_at: stored.viewed_at > pinned.viewed_at ? stored.viewed_at : pinned.viewed_at } : pinned]
  const rest = viewed.filter((item) => item.id !== currentId && item.id !== pinned?.id)
  return [...head, ...rest].slice(0, limit)
}
