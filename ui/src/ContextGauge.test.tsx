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
  fireEvent.click(screen.getByRole('button', { name: /Continuer ailleurs/ }))
  expect(opened).toBe(1)
  cleanup()
})

test('avertit au-delà de 30 % sur Claude, et retient la fermeture pour la conversation', () => {
  localStorage.clear()
  const conversation = { id: 'conv-2', title: 'Long fil', provider: 'claude', model: 'opus-5.5' } as Conversation
  const events = [{ type: 'usage' as const, inputTokens: 1, outputTokens: 1, contextTokens: 320_000, contextWindowTokens: 1_000_000 }]
  let opened = 0
  const props = { conversation, events, onContinueElsewhere: () => { opened += 1 } }
  const view = render(createElement(ContextGauge, props))

  const warning = screen.getByRole('status')
  expect(warning.textContent).toContain('Contexte à 32 %')
  fireEvent.click(screen.getAllByRole('button', { name: 'Continuer ailleurs' })[0]!)
  expect(opened).toBe(1)

  fireEvent.click(screen.getByRole('button', { name: 'Masquer l’avertissement' }))
  expect(screen.queryByRole('status')).toBeNull()
  view.unmount()
  render(createElement(ContextGauge, props))
  expect(screen.queryByRole('status')).toBeNull()

  cleanup()
  render(createElement(ContextGauge, { ...props, conversation: { ...conversation, id: 'conv-3' } }))
  expect(screen.getByRole('status')).toBeTruthy()
  cleanup()
})

test('n’avertit pas Codex avant 70 %', () => {
  render(createElement(ContextGauge, {
    conversation: { id: 'conv-4', title: 'Codex', provider: 'codex', model: 'gpt-5.6-sol' } as Conversation,
    events: [{ type: 'usage', inputTokens: 1, outputTokens: 1, contextTokens: 260_000, contextWindowTokens: 400_000 }],
    onContinueElsewhere: () => {},
  }))
  expect(screen.queryByRole('status')).toBeNull()
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
