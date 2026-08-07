import type { SkillSuggestion } from './types'

export const SKILL_SUGGESTION_ACTION_LABEL = 'Ajouter au message'
export type SuggestionFeedback = 'useful' | 'irrelevant'
export type SuggestionFeedbackMap = Record<string, SuggestionFeedback>

export function suggestionFeedbackKey(projectId: string, skillId: string): string {
  return `${projectId}\u0000${skillId}`
}

export function setSuggestionFeedback(
  feedback: SuggestionFeedbackMap,
  projectId: string,
  skillId: string,
  value: SuggestionFeedback,
): SuggestionFeedbackMap {
  const key = suggestionFeedbackKey(projectId, skillId)
  const next = { ...feedback }
  if (next[key] === value) delete next[key]
  else next[key] = value
  return next
}

export function rankSuggestionsWithFeedback(
  suggestions: SkillSuggestion[],
  projectId: string,
  feedback: SuggestionFeedbackMap,
): SkillSuggestion[] {
  return suggestions
    .map((suggestion, index) => ({
      suggestion,
      index,
      rank: feedback[suggestionFeedbackKey(projectId, suggestion.id)] === 'useful'
        ? 0
        : feedback[suggestionFeedbackKey(projectId, suggestion.id)] === 'irrelevant'
          ? 2
          : 1,
    }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ suggestion }) => suggestion)
}
