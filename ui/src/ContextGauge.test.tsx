import { expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { Conversation } from './types'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { ContextGauge } = await import('./ContextGauge')
const { formatContextWindow } = await import('./contextEstimate')

test('affiche le compteur, puis propose au survol les trois façons de passer la main', async () => {
  let opened = 0
  const copied: string[] = []
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (text: string) => { copied.push(text) } },
  })
  render(createElement(ContextGauge, {
    conversation: { id: 'conv-1', title: 'Jauge de contexte', provider: 'codex', model: 'gpt-5.6-sol' } as Conversation,
    events: [{ type: 'usage', inputTokens: 1, outputTokens: 1, contextTokens: 40_000, contextWindowTokens: 400_000 }],
    onHandoff: () => { opened += 1 },
  }))

  expect(screen.getByRole('progressbar', { name: 'Contexte 10 %, fenêtre 400k' })).toBeTruthy()
  expect(document.body.textContent).toContain('10 %· 400k')
  fireEvent.click(screen.getByRole('button', { name: /Préparer un handoff/ }))
  expect(opened).toBe(1)

  fireEvent.click(screen.getByRole('button', { name: /Copier la référence/ }))
  await waitFor(() => expect(copied).toHaveLength(1))
  expect(copied[0]).toContain('« Jauge de contexte » (id : conv-1)')
  expect(copied[0]).toContain('read_conversation')
  cleanup()
})

test('formate les tailles de fenêtre sans bruit', () => {
  expect(formatContextWindow(256_000)).toBe('256k')
  expect(formatContextWindow(1_000_000)).toBe('1M')
  expect(formatContextWindow(1_050_000)).toBe('1,05M')
})
