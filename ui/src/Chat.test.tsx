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
    onProjectUpdated: () => undefined,
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
    onProjectUpdated: () => undefined,
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
    onProjectUpdated: () => undefined,
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
