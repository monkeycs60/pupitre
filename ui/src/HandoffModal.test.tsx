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
    onDraft: () => {},
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

test('ouvert sur le handoff, le génère puis le confie au composer sans lancer de conversation', async () => {
  const calls: string[] = []
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push(`${init?.method ?? 'GET'} ${url}`)
    if (url.endsWith('/discussion-document')) {
      return Response.json({ filename: 'discussion.md', contentMd: '# Discussion', createdAt: '2026-08-24T00:00:00.000Z' })
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
  const drafts: string[] = []

  render(createElement(HandoffModal, {
    conversation,
    startWith: 'handoff',
    onClose: () => {},
    onDraft: (handoffMd: string) => { drafts.push(handoffMd) },
  }))

  await screen.findByLabelText('Aperçu du document de handoff')
  expect(calls.filter((call) => call.startsWith('POST')).length).toBe(1)
  fireEvent.click(screen.getByRole('button', { name: 'Préparer la nouvelle conversation' }))
  expect(drafts).toEqual(['# Handoff\n\nSynthèse'])
  expect(calls.some((call) => call.includes('handoff-conversation'))).toBe(false)
})
