import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { AppSettingsView } = await import('./AppSettingsView')
const defaultFetch = globalThis.fetch

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  cleanup()
  globalThis.fetch = defaultFetch
})

const stableHealth = {
  ok: true as const,
  instance: 'stable' as const,
  port: 4820,
  pid: 10,
  appPid: 9,
  startedAt: '2026-09-01T09:12:00.000Z',
  build: { sha: 'abc1234', dirty: false, source: 'build' as const },
  staleSources: 0,
}

test('masque la promotion dans l’instance stable', async () => {
  globalThis.fetch = mock(async () => json({})) as typeof fetch
  render(createElement(AppSettingsView, { instance: stableHealth }))
  await screen.findByText('Paramètres globaux')
  expect(screen.queryByRole('heading', { name: 'Instance' })).toBeNull()
})

test('confie aussi un arbre modifié à Luna', async () => {
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.endsWith('/api/settings')) return json({})
    if (url.endsWith('/api/promotion/stable')) return json({ running: false })
    if (url.endsWith('/api/promotion/mission')) return json(null)
    throw new Error(`route inattendue: ${url}`)
  }) as typeof fetch
  render(createElement(AppSettingsView, {
    instance: {
      ...stableHealth,
      instance: 'dev',
      port: 4821,
      build: { ...stableHealth.build, dirty: true, source: 'git' },
    },
  }))
  expect(await screen.findByRole('heading', { name: 'Instance' })).toBeTruthy()
  expect((screen.getByRole('button', { name: 'Confier la promotion à Luna' }) as HTMLButtonElement).disabled).toBe(false)
  expect(screen.getByText(/Luna committe l’état courant/)).toBeTruthy()
})

test('affiche le chat et l’état d’une mission en cours', async () => {
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.endsWith('/api/settings')) return json({})
    if (url.endsWith('/api/promotion/stable')) return json({ running: true })
    if (url.includes('/api/conversations/c1/events')) return json({ events: [], nextBefore: null })
    if (url.endsWith('/api/promotion/mission')) return json({
      conversationId: 'c1', projectId: 'p1', state: 'running',
      startedAt: '2026-09-03T08:43:50.000Z', finishedAt: null,
    })
    throw new Error(`route inattendue: ${url}`)
  }) as typeof fetch

  render(createElement(AppSettingsView, {
    instance: {
      ...stableHealth,
      instance: 'dev',
      port: 4821,
      build: { ...stableHealth.build, source: 'git' },
    },
  }))

  expect(await screen.findByText('Luna travaille')).toBeTruthy()
  expect((screen.getByLabelText('Répondre à Luna') as HTMLTextAreaElement).disabled).toBe(true)
})

test('crée la mission au clic', async () => {
  let started = false
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    if (url.endsWith('/api/settings')) return json({})
    if (url.endsWith('/api/promotion/stable')) return json({ running: false })
    if (url.includes('/api/conversations/c1/events')) return json({ events: [], nextBefore: null })
    if (url.endsWith('/api/promotion/mission') && method === 'POST') {
      started = true
      return json({ conversationId: 'c1', projectId: 'p1', state: 'running', startedAt: 'now', finishedAt: null })
    }
    if (url.endsWith('/api/promotion/mission')) return json(started
      ? { conversationId: 'c1', projectId: 'p1', state: 'running', startedAt: 'now', finishedAt: null }
      : null)
    throw new Error(`route inattendue: ${method} ${url}`)
  }) as typeof fetch

  render(createElement(AppSettingsView, {
    instance: {
      ...stableHealth,
      instance: 'dev',
      port: 4821,
      build: { ...stableHealth.build, source: 'git' },
    },
  }))

  fireEvent.click(await screen.findByRole('button', { name: 'Confier la promotion à Luna' }))

  await waitFor(() => {
    expect(started).toBe(true)
    expect(screen.getByText('Luna travaille')).toBeTruthy()
  }, { timeout: 2_500 })
})

test('enregistre puis efface un token d’intégration sans jamais le relire', async () => {
  const writes: Array<Record<string, unknown>> = []
  let settings = {
    filesystemScope: 'project-and-ai-roots',
    actionFormat: {
      enabled: true,
      todoHeadings: ['TODO'],
      followUpHeadings: ['FOLLOW-UP'],
    },
    integrationTokens: {} as Record<string, boolean>,
  }

  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    if (!url.endsWith('/api/settings')) throw new Error(`route inattendue: ${method} ${url}`)
    if (method === 'GET') return json(settings)

    const body = JSON.parse(String(init?.body ?? '{}')) as {
      integrationTokens?: Partial<Record<'clickup' | 'gitlab', string | null>>
    }
    writes.push(body)
    const patch = body.integrationTokens ?? {}
    const nextTokens = { ...settings.integrationTokens }
    for (const [name, value] of Object.entries(patch)) {
      if (typeof value === 'string' && value.length > 0) nextTokens[name] = true
      if (value === null || value === '') delete nextTokens[name]
    }
    settings = { ...settings, integrationTokens: nextTokens }
    return json(settings)
  }) as typeof fetch

  render(createElement(AppSettingsView))

  const clickupInput = await screen.findByLabelText('Token ClickUp')
  expect(screen.getByLabelText('Statut token ClickUp').textContent).toContain('non défini')

  fireEvent.change(clickupInput, { target: { value: 'pk_secret' } })
  fireEvent.click(screen.getByRole('button', { name: 'Enregistrer les tokens' }))

  await waitFor(() => expect(writes).toContainEqual({ integrationTokens: { clickup: 'pk_secret' } }))
  expect(screen.getByLabelText('Statut token ClickUp').textContent).toContain('défini')
  expect((clickupInput as HTMLInputElement).value).toBe('')
  expect(document.body.textContent).not.toContain('pk_secret')

  fireEvent.click(screen.getByRole('button', { name: 'Effacer le token ClickUp' }))

  await waitFor(() => expect(writes).toContainEqual({ integrationTokens: { clickup: null } }))
  expect(screen.getByLabelText('Statut token ClickUp').textContent).toContain('non défini')
})
