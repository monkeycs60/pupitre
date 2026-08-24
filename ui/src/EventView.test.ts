import { expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import { summarizeTurnError } from './turnError'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, render, screen } = await import('@testing-library/react')
const { EventView } = await import('./EventView')

test('résume une erreur technique longue et garde un détail nettoyé', () => {
  const result = summarizeTurnError(
    'codex app-server arrêté (shutdown) : \u001b[31mERROR\u001b[0m command failed avec une très longue commande',
  )

  expect(result.message).toBe('codex app-server arrêté (shutdown)')
  expect(result.details).toBe('ERROR command failed avec une très longue commande')
})

test('le pied de tour expose seulement la durée du run et les tokens directionnels', () => {
  render(createElement(EventView, {
    block: {
      kind: 'turn-footer',
      id: 'footer-1',
      status: { type: 'status', state: 'done' },
      timing: {
        startedAt: '2026-08-24T10:00:00.000Z',
        firstResponseAt: '2026-08-24T10:00:05.100Z',
        completedAt: '2026-08-24T10:04:06.000Z',
      },
      usage: { inputTokens: 50, outputTokens: 16_083 },
    },
    onImageOpen: () => {},
    onImageLoad: () => {},
  }))

  expect(screen.getByTitle('Durée du run').textContent).toBe('4 min 06 s')
  expect(screen.getByTitle('Tokens en entrée').getAttribute('aria-label')).toBe('50 tokens en entrée')
  expect(screen.getByTitle('Tokens en sortie').getAttribute('aria-label')).toBe('16 083 tokens en sortie')
  expect(document.body.textContent).not.toContain('1er retour')
  expect(document.body.textContent).not.toContain('Lancer le Gardien')
  expect(document.body.textContent).not.toContain('+0 min')
  cleanup()
})
