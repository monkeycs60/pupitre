import { expect, test } from 'bun:test'
import {
  latestUserText,
  withSkillInvocation,
} from '../../ui/src/skillSuggestionDraft'

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
