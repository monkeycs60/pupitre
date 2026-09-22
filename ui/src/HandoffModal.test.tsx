import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { Conversation } from './types'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { HandoffModal } = await import('./HandoffModal')
const defaultFetch = globalThis.fetch

afterEach(() => {
  cleanup()
  globalThis.fetch = defaultFetch
})

const conversation = {
  id: 'conversation-1',
  project_id: 'project-1',
  title: 'Refonte du handoff',
  provider: 'codex',
  model: 'gpt-5.6-sol',
  effort: 'high',
  speed: 'standard',
} as Conversation

test('sépare la discussion fidèle du handoff généré', async () => {
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/discussion-document')) {
      return Response.json({
        filename: 'discussion.md',
        contentMd: '# Discussion\n\n### Utilisateur\n\nBonjour',
        createdAt: '2026-08-24T00:00:00.000Z',
      })
    }
    if (url.endsWith('/handoff-document') && init?.method === 'POST') {
      return Response.json({
        debriefId: 'debrief-1',
        filename: 'handoff.md',
        contentMd: '# Handoff\n\nSynthèse',
        createdAt: '2026-08-24T00:00:00.000Z',
      }, { status: 201 })
    }
    return Response.json({ error: 'route inattendue' }, { status: 404 })
  }) as typeof fetch

  render(createElement(HandoffModal, {
    conversation,
    onClose: () => {},
    onCreated: () => {},
  }))

  expect(await screen.findByLabelText('Aperçu de la discussion complète')).toBeTruthy()
  expect(screen.getByText('Bonjour')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Copier la discussion' })).toBeTruthy()

  fireEvent.click(screen.getByRole('tab', { name: 'Handoff généré' }))
  fireEvent.click(screen.getByRole('button', { name: 'Générer le handoff' }))
  await waitFor(() => expect(screen.getByLabelText('Aperçu du document de handoff')).toBeTruthy())
  expect(screen.getByText('Synthèse')).toBeTruthy()

  fireEvent.click(screen.getByRole('tab', { name: 'Discussion complète' }))
  expect(screen.getByText('Bonjour')).toBeTruthy()
})

test('changer de provider applique le réglage par défaut du provider', async () => {
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/discussion-document')) {
      return Response.json({ filename: 'discussion.md', contentMd: '# Discussion', createdAt: '2026-08-24T00:00:00.000Z' })
    }
    if (url.endsWith('/handoff-document') && init?.method === 'POST') {
      return Response.json({
        debriefId: 'debrief-1',
        filename: 'handoff.md',
        contentMd: '# Handoff',
        createdAt: '2026-08-24T00:00:00.000Z',
      }, { status: 201 })
    }
    return Response.json({ error: 'route inattendue' }, { status: 404 })
  }) as typeof fetch

  render(createElement(HandoffModal, {
    conversation,
    onClose: () => {},
    onCreated: () => {},
  }))

  fireEvent.click(await screen.findByRole('tab', { name: 'Handoff généré' }))
  fireEvent.click(screen.getByRole('button', { name: 'Générer le handoff' }))
  await screen.findByLabelText('Aperçu du document de handoff')

  // La grille reprend le réglage de la conversation ; à la bascule, le défaut
  // du provider s'applique (modèle et effort ensemble), jamais son premier
  // modèle de catalogue ni un « high » générique.
  const cases: Array<{ provider: string; model: string; effort: string }> = [
    { provider: 'claude', model: 'opus-5.5', effort: 'medium' },
    { provider: 'grok', model: 'grok-4.6', effort: 'high' },
    { provider: 'reasonix', model: 'go41', effort: 'high' },
    { provider: 'codex', model: 'gpt-6-sol', effort: 'high' },
  ]

  for (const expected of cases) {
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: expected.provider } })
    expect((screen.getByLabelText('Modèle') as HTMLSelectElement).value).toBe(expected.model)
    expect((screen.getByLabelText('Effort') as HTMLSelectElement).value).toBe(expected.effort)
  }
})
