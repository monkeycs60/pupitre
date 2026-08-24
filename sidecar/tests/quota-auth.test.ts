import { expect, test } from 'bun:test'
import { quotaAuthCommand } from '../src/quota-auth'

test('associe chaque provider à sa commande de connexion interactive', () => {
  expect(quotaAuthCommand('claude', {})).toEqual(['claude', 'auth', 'login'])
  expect(quotaAuthCommand('codex', {})).toEqual(['codex', 'login'])
  expect(quotaAuthCommand('grok', {})).toEqual(['grok', 'login', '--oauth'])
})
