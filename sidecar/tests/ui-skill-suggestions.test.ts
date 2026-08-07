import { expect, test } from 'bun:test'
import type { SkillSuggestion } from '../../ui/src/types'
import {
  SKILL_SUGGESTION_ACTION_LABEL,
  rankSuggestionsWithFeedback,
  setSuggestionFeedback,
  suggestionFeedbackKey,
} from '../../ui/src/skillSuggestionFeedback'
import {
  latestUserText,
  withSkillInvocation,
} from '../../ui/src/skillSuggestionDraft'

function suggestion(id: string): SkillSuggestion {
  return { id } as SkillSuggestion
}

test('le brouillon prime, sinon le panneau peut relire le dernier message utilisateur', () => {
  expect(latestUserText([
    { type: 'user-message', text: 'premier', images: [] },
    { type: 'text-final', text: 'réponse' },
    { type: 'user-message', text: 'dernier', images: [] },
  ])).toBe('dernier')
})

test('Lancer préfixe une seule invocation sans effacer le brouillon', () => {
  expect(withSkillInvocation('Réponds à ce ticket', 'csm-support'))
    .toBe('$csm-support\n\nRéponds à ce ticket')
  expect(withSkillInvocation('$csm-support\n\nDéjà prêt', 'csm-support'))
    .toBe('$csm-support\n\nDéjà prêt')
  expect(withSkillInvocation('', 'csm-support')).toBe('$csm-support ')
})

test('l’action de suggestion décrit bien un ajout au message', () => {
  expect(SKILL_SUGGESTION_ACTION_LABEL).toBe('Ajouter au message')
})

test('le feedback local reclasse les suggestions par projet et se retire au second clic', () => {
  const suggestions = [suggestion('irrelevant'), suggestion('neutral'), suggestion('useful')]
  let feedback = setSuggestionFeedback({}, 'project-a', 'useful', 'useful')
  feedback = setSuggestionFeedback(feedback, 'project-a', 'irrelevant', 'irrelevant')

  expect(rankSuggestionsWithFeedback(suggestions, 'project-a', feedback).map((item) => item.id))
    .toEqual(['useful', 'neutral', 'irrelevant'])
  expect(rankSuggestionsWithFeedback(
    suggestions,
    'project-b',
    feedback,
  ).map((item) => item.id)).toEqual(['irrelevant', 'neutral', 'useful'])

  feedback = setSuggestionFeedback(feedback, 'project-a', 'useful', 'useful')
  expect(feedback[suggestionFeedbackKey('project-a', 'useful')]).toBeUndefined()
})
