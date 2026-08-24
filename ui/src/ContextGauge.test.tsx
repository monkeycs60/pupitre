import { expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { Conversation } from './types'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const { ContextGauge } = await import('./ContextGauge')
const { formatContextWindow } = await import('./contextEstimate')

test('affiche le pourcentage et la fenêtre provider puis ouvre le handoff', () => {
  let opened = 0
  render(createElement(ContextGauge, {
    conversation: { provider: 'codex', model: 'gpt-5.6-sol' } as Conversation,
    events: [{ type: 'usage', inputTokens: 1, outputTokens: 1, contextTokens: 40_000, contextWindowTokens: 400_000 }],
    onHandoff: () => { opened += 1 },
  }))

  expect(screen.getByRole('progressbar', { name: 'Contexte 10 %, fenêtre 400k' })).toBeTruthy()
  expect(document.body.textContent).toContain('10 %· 400k')
  expect(document.body.textContent).not.toContain('tokens occupés')
  fireEvent.click(screen.getByRole('button', { name: 'Passer la main' }))
  expect(opened).toBe(1)
  cleanup()
})

test('formate les tailles de fenêtre sans bruit', () => {
  expect(formatContextWindow(256_000)).toBe('256k')
  expect(formatContextWindow(1_000_000)).toBe('1M')
})
