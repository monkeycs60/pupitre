import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { Project, QuotaSnapshot } from './types'

if (typeof document === 'undefined') GlobalRegistrator.register()

mock.module('@tauri-apps/api/core', () => ({ invoke: mock(() => Promise.resolve(null)) }))
mock.module('@tauri-apps/api/webview', () => ({
  getCurrentWebview: mock(() => ({
    onDragDropEvent: mock(() => Promise.resolve(() => undefined)),
  })),
}))

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { Chat } = await import('./Chat')

const defaultFetch = globalThis.fetch

afterEach(() => {
  cleanup()
  globalThis.fetch = defaultFetch
  localStorage.clear()
})

const project = {
  id: 'project-1',
  name: 'Projet de test',
  path: '/tmp/project-1',
} as Project

const quotas: QuotaSnapshot = { claude: null, codex: null, grok: null }

test('une entrée ticket n’hérite pas du brouillon new:<project> existant', async () => {
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/api/presets')) return Response.json([])
    if (url.includes('/api/projects/project-1/git')) {
      return Response.json({ branches: [], worktrees: [], commits: [], currentBranch: 'main' })
    }
    return Response.json({ error: 'route inattendue' }, { status: 404 })
  }) as typeof fetch
  localStorage.setItem('pupitre:draft:new:project-1', 'ancien texte parasite')

  render(createElement(Chat, {
    events: [],
    connection: 'open',
    retryAt: null,
    conversation: null,
    project,
    quotas,
    onConversationCreated: () => undefined,
    initialMessage: 'contexte du ticket TECH-1',
    ticketId: 'ticket-1',
    reviewStatus: null,
    onOpenCode: () => undefined,
  }))

  await waitFor(() => {
    expect(screen.getByLabelText('Message')).toHaveProperty('value', 'contexte du ticket TECH-1')
  })
})

test('une nouvelle conversation sans ticket conserve le brouillon du projet', async () => {
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/api/presets')) return Response.json([])
    if (url.includes('/api/projects/project-1/git')) {
      return Response.json({ branches: [], worktrees: [], commits: [], currentBranch: 'main' })
    }
    return Response.json({ error: 'route inattendue' }, { status: 404 })
  }) as typeof fetch
  localStorage.setItem('pupitre:draft:new:project-1', 'brouillon normal à reprendre')

  render(createElement(Chat, {
    events: [],
    connection: 'open',
    retryAt: null,
    conversation: null,
    project,
    quotas,
    onConversationCreated: () => undefined,
    initialMessage: 'nouveau message',
    reviewStatus: null,
    onOpenCode: () => undefined,
  }))

  await waitFor(() => {
    expect(screen.getByLabelText('Message')).toHaveProperty('value', 'brouillon normal à reprendre')
  })
})

test('une activité dans la conversation la signale comme lue', async () => {
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/api/presets')) return Response.json([])
    if (url.includes('/api/projects/project-1/git')) {
      return Response.json({ branches: [], worktrees: [], commits: [], currentBranch: 'main' })
    }
    return Response.json({ error: 'route inattendue' }, { status: 404 })
  }) as typeof fetch
  const onConversationRead = mock(() => undefined)

  render(createElement(Chat, {
    events: [],
    connection: 'open',
    retryAt: null,
    conversation: null,
    project,
    quotas,
    onConversationCreated: () => undefined,
    onConversationRead,
    reviewStatus: null,
    onOpenCode: () => undefined,
  }))

  const composer = await screen.findByLabelText('Message')
  expect(onConversationRead).toHaveBeenCalledTimes(0)
  fireEvent.pointerDown(composer)
  expect(onConversationRead).toHaveBeenCalledTimes(1)
  fireEvent.keyDown(composer, { key: 'a' })
  expect(onConversationRead).toHaveBeenCalledTimes(2)
})

test('la piste ★ de la dernière réponse laisse le composer vide et décoché', async () => {
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/api/presets')) return Response.json([])
    if (url.includes('/documents')) return Response.json([])
    if (url.includes('/api/projects/project-1/git')) {
      return Response.json({ branches: [], worktrees: [], commits: [], currentBranch: 'main' })
    }
    return Response.json({ error: 'route inattendue' }, { status: 404 })
  }) as typeof fetch
  const reply = 'Fait.\n\n*FOLLOW-UP*\n- Ajouter un export\n- ★ Mettre en cache le rendu'

  render(createElement(Chat, {
    events: [
      { id: 1, type: 'user-message', text: 'Corrige le rendu', images: [] },
      { id: 2, type: 'status', state: 'running' },
      { id: 3, type: 'text-final', text: reply },
      { id: 4, type: 'status', state: 'done' },
    ],
    connection: 'open',
    retryAt: null,
    conversation: { id: 'conv-star', project_id: 'project-1', title: 'Rendu', provider: 'claude', model: 'haiku' } as never,
    project,
    quotas,
    onConversationCreated: () => undefined,
    reviewStatus: null,
    onOpenCode: () => undefined,
  }))

  const composer = await screen.findByLabelText('Message') as HTMLTextAreaElement
  const boxes = await screen.findAllByRole('checkbox') as HTMLInputElement[]
  expect(boxes.map((box) => box.checked)).toEqual([false, false])
  expect(composer.value).toBe('')
})

test('les passages Jarvis recentrent le fil au clic, pas quand le fil se met à jour', async () => {
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/api/presets')) return Response.json([])
    if (url.includes('/documents')) return Response.json([])
    if (url.includes('/api/projects/project-1/git')) {
      return Response.json({ branches: [], worktrees: [], commits: [], currentBranch: 'main' })
    }
    return Response.json({ error: 'route inattendue' }, { status: 404 })
  }) as typeof fetch
  const centered: Element[] = []
  const original = HTMLElement.prototype.scrollIntoView
  HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) { centered.push(this) }
  try {
    const events = [
      { id: 1, type: 'user-message' as const, text: 'Où en est la facture ?', images: [] },
      { id: 2, type: 'status' as const, state: 'running' as const },
      { id: 3, type: 'text-final' as const, text: 'La facture part demain.' },
      { id: 4, type: 'status' as const, state: 'done' as const },
    ]
    const props = {
      events,
      connection: 'open' as const,
      retryAt: null,
      conversation: { id: 'conv-hits', project_id: 'project-1', title: 'Factures', provider: 'claude', model: 'haiku' } as never,
      project,
      quotas,
      onConversationCreated: () => undefined,
      reviewStatus: null,
      onOpenCode: () => undefined,
      highlightEventIds: [3],
    }
    const { rerender } = render(createElement(Chat, props))
    await screen.findByText('Jarvis · 1 / 1 passage')
    const first = centered.filter((element) => element.classList.contains('is-jarvis-hit')).length
    expect(first).toBe(1)

    rerender(createElement(Chat, { ...props, events: [...events, { id: 5, type: 'user-message' as const, text: 'Merci', images: [] }] }))
    rerender(createElement(Chat, { ...props, events: [...events] }))
    expect(centered.filter((element) => element.classList.contains('is-jarvis-hit'))).toHaveLength(1)
    expect(document.querySelectorAll('.is-jarvis-hit.is-jarvis-current')).toHaveLength(1)

    rerender(createElement(Chat, { ...props, highlightEventIds: [3] }))
    expect(centered.filter((element) => element.classList.contains('is-jarvis-hit'))).toHaveLength(2)
  } finally {
    HTMLElement.prototype.scrollIntoView = original
  }
})
