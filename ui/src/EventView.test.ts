import { expect, test } from 'bun:test'
import { summarizeTurnError } from './turnError'

test('résume une erreur technique longue et garde un détail nettoyé', () => {
  const result = summarizeTurnError(
    'codex app-server arrêté (shutdown) : \u001b[31mERROR\u001b[0m command failed avec une très longue commande',
  )

  expect(result.message).toBe('codex app-server arrêté (shutdown)')
  expect(result.details).toBe('ERROR command failed avec une très longue commande')
})
