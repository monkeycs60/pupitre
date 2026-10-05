import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { Rail } = await import('./Rail')
const defaultFetch = globalThis.fetch

afterEach(() => {
  cleanup()
  globalThis.fetch = defaultFetch
})

test('ne porte que les projets : les destinations vivent dans la barre de titre', async () => {
  globalThis.fetch = mock(async () => Response.json([
    { id: 'p1', name: 'affilae mono', path: '/tmp/a', pinned: false },
  ])) as typeof fetch
  render(createElement(Rail, {
    selectedProject: null,
    projectListVersion: 0,
    workspaceView: 'conversations',
    onProjectSelect: () => {},
    onProjectCreated: () => {},
  }))

  expect(await screen.findByRole('button', { name: 'affilae mono' })).toBeTruthy()
  for (const label of ['Conversations', 'Projet', 'Activité', 'Contexte', 'Automatisations', 'Utilisation', 'Réglages', 'Aide']) {
    expect(screen.queryByRole('button', { name: label })).toBeNull()
  }
})

test('retire un projet seulement après confirmation dans la modale', async () => {
  const calls: string[] = []
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push(`${init?.method ?? 'GET'} ${url}`)
    if (init?.method === 'DELETE') return new Response(null, { status: 204 })
    if (url.includes('unread')) return Response.json({})
    return Response.json([
      { id: 'p1', name: 'affilae mono', path: '/tmp/a', pinned: false },
      { id: 'p2', name: 'pupitre', path: '/tmp/b', pinned: false },
    ])
  }) as typeof fetch
  const removed: string[] = []
  render(createElement(Rail, {
    selectedProject: null,
    projectListVersion: 0,
    workspaceView: 'conversations',
    onProjectSelect: () => {},
    onProjectCreated: () => {},
    onProjectRemoved: (project: { id: string }) => removed.push(project.id),
  }))

  fireEvent.click(await screen.findByRole('button', { name: 'Actions pour le projet pupitre' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Retirer le projet…' }))
  expect(screen.getByRole('alertdialog').textContent).toContain('/tmp/b')
  expect(calls.some((call) => call.startsWith('DELETE'))).toBe(false)

  fireEvent.click(screen.getByRole('button', { name: 'Retirer le projet' }))
  await waitFor(() => expect(removed).toEqual(['p2']))
  expect(calls).toContain('DELETE /api/projects/p2')
  expect(screen.queryByRole('alertdialog')).toBeNull()
  expect(screen.queryByRole('button', { name: 'pupitre' })).toBeNull()
})

test('archiver un projet le range dans le groupe Archives, replié par défaut', async () => {
  let archivedAt: string | null = null
  const patches: unknown[] = []
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('unread')) return Response.json({})
    const pupitre = { id: 'p2', name: 'pupitre', path: '/tmp/b', pinned: false, color: '#ff922b', icon: 'initials', archived_at: archivedAt }
    if (init?.method === 'PATCH') {
      patches.push(JSON.parse(String(init.body)))
      archivedAt = '2026-10-05T10:00:00.000Z'
      return Response.json({ ...pupitre, archived_at: archivedAt })
    }
    return Response.json([
      { id: 'p1', name: 'affilae mono', path: '/tmp/a', pinned: false, color: '#8b7cff', icon: 'initials', archived_at: null },
      pupitre,
    ])
  }) as typeof fetch
  render(createElement(Rail, {
    selectedProject: null,
    projectListVersion: 0,
    workspaceView: 'conversations',
    onProjectSelect: () => {},
    onProjectCreated: () => {},
  }))

  fireEvent.click(await screen.findByRole('button', { name: 'Actions pour le projet pupitre' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Archiver' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'pupitre' })).toBeNull())
  expect(patches).toEqual([{ archived: true }])
  const toggle = screen.getByRole('button', { name: /Archives/ })
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(toggle)
  expect(screen.getByRole('button', { name: 'pupitre' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'affilae mono' })).toBeTruthy()
})
