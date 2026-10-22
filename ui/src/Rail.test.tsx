import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { Rail, dropGroup, railItems } = await import('./Rail')
const defaultFetch = globalThis.fetch

afterEach(() => {
  cleanup()
  localStorage.clear()
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
  const toggle = await screen.findByRole('button', { name: /Archives/ })
  expect(screen.queryByRole('button', { name: 'pupitre' })).toBeNull()
  expect(patches).toEqual([{ archived: true }])
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(toggle)
  expect(screen.getByRole('button', { name: 'pupitre' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'affilae mono' })).toBeTruthy()
})

test('dessine une comète par conversation en cours, sur le projet courant aussi', async () => {
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    if (String(input).includes('unread')) return Response.json({})
    return Response.json([
      { id: 'p1', name: 'affilae mono', path: '/tmp/a', pinned: false },
      { id: 'p2', name: 'pupitre', path: '/tmp/b', pinned: false },
      { id: 'p3', name: 'vrac', path: '/tmp/c', pinned: false },
    ])
  }) as typeof fetch
  render(createElement(Rail, {
    selectedProject: { id: 'p1', name: 'affilae mono', path: '/tmp/a', pinned: false } as never,
    projectListVersion: 0,
    workspaceView: 'conversations',
    onProjectSelect: () => {},
    onProjectCreated: () => {},
    liveConversationsByProject: { p1: 3, p2: 1 },
  }))

  const current = await screen.findByRole('button', { name: 'affilae mono, 3 conversations en cours' })
  const ring = current.querySelector<HTMLElement>('.rail-live-ring')
  expect(ring?.dataset.count).toBe('3')
  expect(ring?.style.getPropertyValue('--live-period')).toBe('120deg')
  expect(screen.getByRole('button', { name: 'pupitre, 1 conversation en cours' }).querySelectorAll('.rail-live-ring')).toHaveLength(1)
  expect(screen.getByRole('button', { name: 'vrac' }).querySelector('.rail-live-ring')).toBeNull()
})

const project = (id: string, group_id: string | null = null) => ({ id, name: id, path: `/tmp/${id}`, pinned: false, color: '#4f8cff', icon: 'initials' as const, archived_at: null, group_id, filesystem_scope: 'project-and-ai-roots' as const, created_at: '', default_preset_id: null, auto_rescan: false })
const mmvd = { id: 'g1', name: 'MMVD', color: '#4f8cff', created_at: '' }

test('un groupe prend la place de son premier projet et rassemble les autres', () => {
  const items = railItems([project('a'), project('p15', 'g1'), project('b'), project('rebuttal', 'g1'), project('orphan', 'disparu')], [mmvd])
  expect(items.map((item) => item.kind === 'group' ? `${item.group.name}[${item.members.map((member) => member.id).join(',')}]` : item.project.id))
    .toEqual(['a', 'MMVD[p15,rebuttal]', 'b', 'orphan'])
})

test('un projet déposé rejoint un groupe entre deux de ses projets, et le quitte ailleurs', () => {
  const groups: Record<string, string | null> = { p15: 'g1', rebuttal: 'g1', larib: null, inflame: 'g2' }
  const groupOf = (id: string) => groups[id] ?? null
  expect(dropGroup(['p15', 'x', 'rebuttal'], 1, null, groupOf)).toBe('g1')
  expect(dropGroup(['larib', 'x', 'p15', 'rebuttal'], 1, null, groupOf)).toBeNull()
  expect(dropGroup(['p15', 'rebuttal', 'x', 'larib'], 2, 'g1', groupOf)).toBe('g1')
  expect(dropGroup(['larib', 'x', 'inflame'], 1, 'g1', groupOf)).toBeNull()
})

function groupedFetch(calls: Array<{ method: string; url: string; body: unknown }>) {
  let projects = [project('larib'), project('p15', 'g1'), project('rebuttal', 'g1')]
  let groups = [mmvd]
  return mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ method, url, body })
    if (url.includes('unread')) return Response.json({ p15: 2, rebuttal: 1 })
    if (url.endsWith('/api/project-groups') && method === 'POST') {
      const group = { id: 'g2', name: body.name, color: '#ff922b', created_at: '' }
      groups = [...groups, group]
      projects = projects.map((item) => body.projectIds.includes(item.id) ? { ...item, group_id: 'g2' } : item)
      return Response.json(group, { status: 201 })
    }
    if (url.includes('/api/project-groups')) return Response.json(groups)
    if (method === 'PATCH') {
      const id = url.split('/').pop()!
      projects = projects.map((item) => item.id === id ? { ...item, group_id: body.groupId } : item)
      return Response.json(projects.find((item) => item.id === id))
    }
    return Response.json(projects)
  }) as unknown as typeof fetch
}

test('un groupe se replie, garde son repli et additionne ses conversations à lire', async () => {
  const calls: Array<{ method: string; url: string; body: unknown }> = []
  globalThis.fetch = groupedFetch(calls)
  const view = render(createElement(Rail, { selectedProject: null, projectListVersion: 0, workspaceView: 'conversations', onProjectSelect: () => {}, onProjectCreated: () => {} }))

  const toggle = await screen.findByRole('button', { name: /^Groupe MMVD, 2 projets/ })
  const group = view.container.querySelector('.rail-group[data-group-id="g1"]')!
  expect([...group.querySelectorAll('.rail-project-label')].map((node) => node.textContent)).toEqual(['p15', 'rebuttal'])
  expect(view.container.querySelector('.rail-projects > .rail-project .rail-project-label')!.textContent).toBe('larib')

  fireEvent.click(toggle)
  expect(group.querySelectorAll('.rail-project')).toHaveLength(0)
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  await waitFor(() => expect(toggle.getAttribute('aria-label')).toBe('Groupe MMVD, 2 projets, 3 à lire'))
  expect(localStorage.getItem('pupitre.rail.foldedGroups')).toBe('["g1"]')
  cleanup()

  render(createElement(Rail, { selectedProject: null, projectListVersion: 0, workspaceView: 'conversations', onProjectSelect: () => {}, onProjectCreated: () => {} }))
  expect((await screen.findByRole('button', { name: /^Groupe MMVD/ })).getAttribute('aria-expanded')).toBe('false')
})

test('le menu d’un projet le range dans un groupe ou en crée un à nommer', async () => {
  const calls: Array<{ method: string; url: string; body: unknown }> = []
  globalThis.fetch = groupedFetch(calls)
  const view = render(createElement(Rail, { selectedProject: null, projectListVersion: 0, workspaceView: 'conversations', onProjectSelect: () => {}, onProjectCreated: () => {} }))

  fireEvent.click(await screen.findByRole('button', { name: 'Actions pour le projet larib' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'MMVD' }))
  await waitFor(() => expect(view.container.querySelectorAll('.rail-group[data-group-id="g1"] .rail-project')).toHaveLength(3))
  expect(calls).toContainEqual({ method: 'PATCH', url: '/api/projects/larib', body: { groupId: 'g1' } })

  fireEvent.click(screen.getByRole('button', { name: 'Actions pour le projet p15' }))
  expect(screen.queryByRole('menuitem', { name: 'MMVD' })).toBeNull()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Nouveau groupe…' }))
  const input = await screen.findByRole('textbox', { name: 'Nouveau nom du groupe Nouveau groupe' })
  expect(calls).toContainEqual({ method: 'POST', url: '/api/project-groups', body: { name: 'Nouveau groupe', projectIds: ['p15'] } })
  expect(view.container.querySelectorAll('.rail-group[data-group-id="g2"] .rail-project')).toHaveLength(1)
  expect(input).toBeTruthy()
})
