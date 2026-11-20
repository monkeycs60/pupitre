import { expect, test } from 'bun:test'
import { parseContinueDirective } from './continueDirective'

test('@continue en tête de message porte la demande, seul ou suivi de texte', () => {
  expect(parseContinueDirective('@continue fais le bilan\net exécute')).toEqual({ instruction: 'fais le bilan\net exécute' })
  expect(parseContinueDirective('  @continue  ')).toEqual({ instruction: '' })
  expect(parseContinueDirective('@continuer la suite')).toBeNull()
  expect(parseContinueDirective('regarde @continue')).toBeNull()
})
