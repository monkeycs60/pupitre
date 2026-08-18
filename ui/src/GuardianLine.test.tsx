import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { Conversation, Project, Review } from './types'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { GuardianLine } = await import('./GuardianLine')
const defaultFetch = globalThis.fetch
const defaultConfirm = window.confirm

afterEach(() => {
  cleanup()
  globalThis.fetch = defaultFetch
  window.confirm = defaultConfirm
})

const project: Project = {
  id: 'project-1',
  name: 'Pupitre',
  path: '/tmp/pupitre',
  permission_mode: 'default',
  filesystem_scope: 'project-and-ai-roots',
  pinned: false,
  created_at: '2026-08-17T00:00:00.000Z',
  default_preset_id: null,
  default_review_preset_id: null,
  default_correction_preset_id: null,
  auto_rescan: false,
}

const conversation: Conversation = {
  id: 'conversation-1',
  project_id: project.id,
  title: 'Correction',
  summary: '',
  provider: 'codex',
  model: 'gpt-5.6-sol',
  effort: 'high',
  speed: 'standard',
  permission_mode: 'default',
  orchestrator: true,
  subagent_preset_id: null,
  subagent_effort: null,
  created_at: '2026-08-17T00:00:00.000Z',
  updated_at: '2026-08-17T00:00:00.000Z',
}

const review: Review = {
  id: 'review-1',
  project_id: project.id,
  conversation_id: conversation.id,
  git_ref_base: 'base',
  git_ref_head: 'head',
  status: 'done',
  review_provider: 'codex',
  review_model: 'gpt-5.6-sol',
  review_effort: 'high',
  review_speed: 'standard',
  diff_text: 'diff',
  error: null,
  created_at: '2026-08-17T00:00:00.000Z',
  updated_at: '2026-08-17T00:00:00.000Z',
  code_provider: 'codex',
  scope: 'worktree',
  parent_review_id: null,
  flags: Array.from({ length: 2 }, (_, index) => ({
    id: `flag-${index + 1}`,
    review_id: 'review-1',
    file: `src/file-${index + 1}.ts`,
    line_start: 1,
    line_end: 1,
    severity: 'red',
    category: 'bug',
    message: 'Erreur',
    status: 'open',
    code_provider: 'codex',
  })),
}

test('signale une relecture du diff exact sans empêcher de relire', async () => {
  let relireCount = 0
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/reviews')) return Response.json([review])
    if (url.endsWith('/diff')) return Response.json({ diff: 'diff', files: [] })
    return Response.json({ error: 'route inattendue' }, { status: 404 })
  }) as typeof fetch

  render(createElement(GuardianLine, {
    conversation,
    project,
    reviewStatus: null,
    onOpenCode: () => undefined,
    onRelire: () => { relireCount += 1 },
  }))

  const line = document.getElementById('guardian-line')
  await waitFor(() => expect(line?.textContent).toContain('✓ relu · 2 rouges'))
  expect(line?.querySelector('.guardian-line-meta')?.getAttribute('title')).toBe('Déjà relu à ce stade précis.')
  fireEvent.click(screen.getByRole('button', { name: 'Relire' }))
  expect(relireCount).toBe(1)
})

test('un diff modifié depuis la relecture signale la péremption', async () => {
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/reviews')) return Response.json([review])
    if (url.endsWith('/diff')) return Response.json({ diff: 'diff modifié', files: [] })
    return Response.json({ error: 'route inattendue' }, { status: 404 })
  }) as typeof fetch

  render(createElement(GuardianLine, {
    conversation,
    project,
    reviewStatus: null,
    onOpenCode: () => undefined,
    onRelire: () => undefined,
  }))

  const button = await screen.findByRole('button', { name: 'Corriger les 2 erreurs' })
  await waitFor(() => expect(document.getElementById('guardian-line')?.textContent).toContain('à relire'))
  expect(document.getElementById('guardian-line')?.textContent).not.toContain('✓ relu')
  expect((button as HTMLButtonElement).disabled).toBe(false)
  const mode = screen.getByRole('combobox', { name: 'Mode de correction' }) as HTMLSelectElement
  expect(mode.disabled).toBe(false)
  fireEvent.change(mode, { target: { value: 'individual' } })
  expect(mode.value).toBe('individual')
})

test('un diff live illisible affiche la review mais la déclare à relire', async () => {
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/reviews')) return Response.json([review])
    if (url.endsWith('/diff')) return Response.json({ error: 'worktree absent' }, { status: 500 })
    return Response.json({ error: 'route inattendue' }, { status: 404 })
  }) as typeof fetch

  render(createElement(GuardianLine, {
    conversation,
    project,
    reviewStatus: null,
    onOpenCode: () => undefined,
    onRelire: () => undefined,
  }))

  expect(await screen.findByRole('button', { name: 'Corriger les 2 erreurs' })).toBeDefined()
  // Un diff qu'on n'a pas pu lire ne prouve pas que la review tient encore.
  await waitFor(() => expect(document.getElementById('guardian-line')?.textContent).toContain('2 rouges · à relire'))
})

test('un rouge ouvert garde la priorité visuelle sur un diff périmé', async () => {
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/reviews')) return Response.json([review])
    if (url.endsWith('/diff')) return Response.json({ diff: 'diff modifié depuis', files: [] })
    return Response.json({ error: 'route inattendue' }, { status: 404 })
  }) as typeof fetch

  render(createElement(GuardianLine, {
    conversation,
    project,
    reviewStatus: null,
    onOpenCode: () => undefined,
    onRelire: () => undefined,
  }))

  const line = await waitFor(() => {
    const node = document.getElementById('guardian-line')
    expect(node?.className).toContain('is-block')
    return node
  })
  expect(line?.className).not.toContain('is-stale')
  expect(line?.textContent).toContain('2 rouges')
  expect(line?.textContent).toContain('à relire')
})

test('sans flag ouvert, un diff périmé rend la ligne neutre', async () => {
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/reviews')) return Response.json([{ ...review, flags: [] }])
    if (url.endsWith('/diff')) return Response.json({ diff: 'diff modifié depuis', files: [] })
    return Response.json({ error: 'route inattendue' }, { status: 404 })
  }) as typeof fetch

  render(createElement(GuardianLine, {
    conversation,
    project,
    reviewStatus: null,
    onOpenCode: () => undefined,
    onRelire: () => undefined,
  }))

  await waitFor(() => expect(document.getElementById('guardian-line')?.className).toContain('is-stale'))
})

test('tant que le diff live n’est pas chargé, une review sans flag ne passe pas au vert', async () => {
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/reviews')) return Response.json([{ ...review, flags: [] }])
    // Le diff ne répond jamais : la comparaison n'a pas eu lieu.
    if (url.endsWith('/diff')) return new Promise<Response>(() => {})
    return Response.json({ error: 'route inattendue' }, { status: 404 })
  }) as typeof fetch

  render(createElement(GuardianLine, {
    conversation,
    project,
    reviewStatus: null,
    onOpenCode: () => undefined,
    onRelire: () => undefined,
  }))

  const line = await waitFor(() => {
    const node = document.getElementById('guardian-line')
    expect(node?.className).toContain('is-stale')
    return node
  })
  expect(line?.className).not.toContain('is-clean')
  // Rien ne prouve encore la péremption : on n'annonce pas « à relire ».
  expect(line?.textContent).toContain('rien à signaler')
  expect(line?.textContent).not.toContain('✓ relu')
  expect(line?.textContent).not.toContain('à relire')
})

test('propose par défaut une seule correction groupée', async () => {
  const requests: Array<{ url: string, init?: RequestInit }> = []
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    requests.push({ url, init })
    if (url.endsWith('/reviews')) return Response.json([review])
    if (url.endsWith('/diff')) return Response.json({ diff: 'diff', files: [] })
    if (url.endsWith('/dispatch-grouped')) return Response.json({ dispatched: 2, subtaskId: 'group-1', flagIds: ['flag-1', 'flag-2'] }, { status: 202 })
    return Response.json({ error: 'route inattendue' }, { status: 404 })
  }) as typeof fetch
  window.confirm = mock(() => true)

  render(createElement(GuardianLine, {
    conversation,
    project,
    reviewStatus: null,
    onOpenCode: () => undefined,
    onRelire: () => undefined,
  }))

  const button = await screen.findByRole('button', { name: 'Corriger les 2 erreurs' })
  const mode = screen.getByRole('combobox', { name: 'Mode de correction' }) as HTMLSelectElement
  expect(mode.value).toBe('grouped')
  expect(mode.nextElementSibling).toBe(button)
  fireEvent.click(button)

  await waitFor(() => expect(requests.some(({ url }) => url.endsWith('/reviews/review-1/dispatch-grouped'))).toBe(true))
  const dispatch = requests.find(({ url }) => url.endsWith('/reviews/review-1/dispatch-grouped'))
  expect(dispatch?.init?.method).toBe('POST')
  expect(JSON.parse(String(dispatch?.init?.body))).toEqual({ severities: ['red', 'orange', 'grey'] })
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Corriger les 2 erreurs' })).toBeNull())
})

test('permet de lancer un agent distinct par erreur', async () => {
  const requests: string[] = []
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = String(input)
    requests.push(url)
    if (url.endsWith('/reviews')) return Response.json([review])
    if (url.endsWith('/diff')) return Response.json({ diff: 'diff', files: [] })
    if (url.endsWith('/dispatch-all')) return Response.json({ dispatched: 2, flagIds: ['flag-1', 'flag-2'] }, { status: 202 })
    return Response.json({ error: 'route inattendue' }, { status: 404 })
  }) as typeof fetch
  window.confirm = mock(() => true)

  render(createElement(GuardianLine, {
    conversation,
    project,
    reviewStatus: null,
    onOpenCode: () => undefined,
    onRelire: () => undefined,
  }))

  const mode = await screen.findByRole('combobox', { name: 'Mode de correction' })
  fireEvent.change(mode, { target: { value: 'individual' } })
  fireEvent.click(screen.getByRole('button', { name: 'Corriger les 2 erreurs' }))

  await waitFor(() => expect(requests.some((url) => url.endsWith('/reviews/review-1/dispatch-all'))).toBe(true))
  expect(requests.some((url) => url.endsWith('/dispatch-grouped'))).toBe(false)
})

test('permet de corriger les signalements affichés quand le diff a bougé', async () => {
  const requests: string[] = []
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = String(input)
    requests.push(url)
    if (url.endsWith('/reviews')) return Response.json([review])
    if (url.endsWith('/diff')) return Response.json({ diff: 'diff modifié', files: [] })
    if (url.endsWith('/dispatch-grouped')) return Response.json({ dispatched: 2, subtaskId: 'group-1', flagIds: ['flag-1', 'flag-2'] }, { status: 202 })
    return Response.json({ error: 'route inattendue' }, { status: 404 })
  }) as typeof fetch
  window.confirm = mock(() => true)

  render(createElement(GuardianLine, {
    conversation,
    project,
    reviewStatus: null,
    onOpenCode: () => undefined,
    onRelire: () => undefined,
  }))

  const button = await screen.findByRole('button', { name: 'Corriger les 2 erreurs' })
  expect((button as HTMLButtonElement).disabled).toBe(false)
  fireEvent.click(button)

  await waitFor(() => expect(document.getElementById('guardian-line')?.textContent).toContain('à relire'))
  await waitFor(() => expect(requests.some((url) => url.endsWith('/dispatch-grouped'))).toBe(true))
})

test('une confirmation refusée ne lance aucune correction', async () => {
  const requests: string[] = []
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = String(input)
    requests.push(url)
    if (url.endsWith('/reviews')) return Response.json([review])
    if (url.endsWith('/diff')) return Response.json({ diff: 'diff', files: [] })
    return Response.json({ error: 'route inattendue' }, { status: 404 })
  }) as typeof fetch
  window.confirm = mock(() => false)

  render(createElement(GuardianLine, {
    conversation,
    project,
    reviewStatus: null,
    onOpenCode: () => undefined,
    onRelire: () => undefined,
  }))

  fireEvent.click(await screen.findByRole('button', { name: 'Corriger les 2 erreurs' }))
  await waitFor(() => expect(window.confirm).toHaveBeenCalled())
  expect(requests.some((url) => url.includes('/dispatch'))).toBe(false)
  expect(screen.getByRole('button', { name: 'Corriger les 2 erreurs' })).toBeDefined()
})

test('la confirmation prévient quand la review est caduque', async () => {
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/reviews')) return Response.json([review])
    if (url.endsWith('/diff')) return Response.json({ diff: 'diff modifié', files: [] })
    if (url.endsWith('/dispatch-grouped')) return Response.json({ dispatched: 2, subtaskId: 'group-1', flagIds: ['flag-1', 'flag-2'] }, { status: 202 })
    return Response.json({ error: 'route inattendue' }, { status: 404 })
  }) as typeof fetch
  const confirm = mock(() => true)
  window.confirm = confirm

  render(createElement(GuardianLine, {
    conversation,
    project,
    reviewStatus: null,
    onOpenCode: () => undefined,
    onRelire: () => undefined,
  }))

  await waitFor(() => expect(document.getElementById('guardian-line')?.textContent).toContain('à relire'))
  fireEvent.click(screen.getByRole('button', { name: 'Corriger les 2 erreurs' }))
  await waitFor(() => expect(confirm).toHaveBeenCalled())
  expect(String(confirm.mock.calls[0]![0])).toContain('périmés')
})

test('un dispatch en échec laisse les signalements ouverts et affiche l’erreur', async () => {
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/reviews')) return Response.json([review])
    if (url.endsWith('/diff')) return Response.json({ diff: 'diff', files: [] })
    if (url.endsWith('/dispatch-grouped')) return Response.json({ error: 'moteur de sous-tâches indisponible' }, { status: 409 })
    return Response.json({ error: 'route inattendue' }, { status: 404 })
  }) as typeof fetch
  window.confirm = mock(() => true)

  render(createElement(GuardianLine, {
    conversation,
    project,
    reviewStatus: null,
    onOpenCode: () => undefined,
    onRelire: () => undefined,
  }))

  fireEvent.click(await screen.findByRole('button', { name: 'Corriger les 2 erreurs' }))
  await waitFor(() => expect(document.getElementById('guardian-line')?.textContent).toContain('moteur de sous-tâches indisponible'))
  expect(screen.getByRole('button', { name: 'Corriger les 2 erreurs' })).toBeDefined()
})

test('un dispatch partiel ne bascule que les signalements confirmés', async () => {
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/reviews')) return Response.json([review])
    if (url.endsWith('/diff')) return Response.json({ diff: 'diff', files: [] })
    if (url.endsWith('/dispatch-grouped')) return Response.json({ dispatched: 1, subtaskId: 'group-1', flagIds: ['flag-1'] }, { status: 202 })
    return Response.json({ error: 'route inattendue' }, { status: 404 })
  }) as typeof fetch
  window.confirm = mock(() => true)

  render(createElement(GuardianLine, {
    conversation,
    project,
    reviewStatus: null,
    onOpenCode: () => undefined,
    onRelire: () => undefined,
  }))

  fireEvent.click(await screen.findByRole('button', { name: 'Corriger les 2 erreurs' }))
  expect(await screen.findByRole('button', { name: 'Corriger l’erreur' })).toBeDefined()
})
