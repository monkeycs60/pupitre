import { expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { Conversation } from './types'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const { ContextGauge } = await import('./ContextGauge')
const { formatContextWindow } = await import('./contextEstimate')
const { conversationReferenceText } = await import('./conversationDraft')

test('affiche le compteur, puis propose au survol les deux façons de passer la main', async () => {
  let opened = 0
  render(createElement(ContextGauge, {
    conversation: { id: 'conv-1', title: 'Jauge de contexte', provider: 'codex', model: 'gpt-5.6-sol' } as Conversation,
    events: [{ type: 'usage', inputTokens: 1, outputTokens: 1, contextTokens: 40_000, contextWindowTokens: 400_000 }],
    onContinueElsewhere: () => { opened += 1 },
  }))

  expect(screen.getByRole('progressbar', { name: 'Contexte 10 %, fenêtre 400k' })).toBeTruthy()
  expect(document.body.textContent).toContain('10 %· 400k')
  expect(screen.getAllByRole('button')).toHaveLength(2)
  expect(screen.queryByRole('button', { name: /handoff/ })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /Continuer la conversation ailleurs/ }))
  expect(opened).toBe(1)
  cleanup()
})

test('la référence nomme la conversation et l’outil pour la relire', () => {
  const text = conversationReferenceText({ id: 'conv-1', title: 'Jauge de contexte' })
  expect(text).toContain('« Jauge de contexte » (id : conv-1)')
  expect(text).toContain('read_conversation')
})

test('formate les tailles de fenêtre sans bruit', () => {
  expect(formatContextWindow(256_000)).toBe('256k')
  expect(formatContextWindow(1_000_000)).toBe('1M')
  expect(formatContextWindow(1_050_000)).toBe('1,05M')
})
