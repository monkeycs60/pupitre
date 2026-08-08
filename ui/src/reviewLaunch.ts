import type { StartReviewInput } from './api'

export interface ReviewComparison {
  base: string
  head: string
}

/** Les refs ne sont nécessaires que lorsque l'utilisateur affiche une comparaison. */
export function reviewStartInput(
  conversationId: string,
  comparison: ReviewComparison | null,
): StartReviewInput {
  if (comparison === null) return { conversationId, scope: 'worktree' }
  return {
    conversationId,
    scope: 'comparison',
    gitRefBase: comparison.base,
    gitRefHead: comparison.head,
  }
}
