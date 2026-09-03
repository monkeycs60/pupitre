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

test('affiche la promotion en dev et bloque un arbre modifié', async () => {
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.endsWith('/api/settings')) return json({})
    if (url.endsWith('/api/promotion/stable')) return json({ running: false })
    if (url.endsWith('/api/promotion')) return json({
      state: 'idle', sha: null, startedAt: null, finishedAt: null, steps: {}, events: [],
    })
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
  expect((screen.getByRole('button', { name: 'Promouvoir cette version' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByText(/Valider ou remiser/)).toBeTruthy()
})

test('affiche immédiatement la cause d’une promotion échouée', async () => {
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.endsWith('/api/settings')) return json({})
    if (url.endsWith('/api/promotion/stable')) return json({ running: true })
    if (url.endsWith('/api/promotion')) return json({
      state: 'failed',
      sha: 'f21d154',
      startedAt: '2026-09-03T08:43:50.000Z',
      finishedAt: '2026-09-03T08:44:01.000Z',
      steps: { preflight: 'done', build: 'running', promotion: 'failed' },
      events: [
        { step: 'build', status: 'running', message: 'construction des binaires release' },
        { step: 'promotion', status: 'failed', message: 'build a échoué (1)' },
      ],
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

  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toContain('Promotion échouée')
  expect(alert.textContent).toContain('promotion')
  expect(alert.textContent).toContain('build a échoué (1)')
})

test('affiche l’activité courante pendant une promotion', async () => {
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.endsWith('/api/settings')) return json({})
    if (url.endsWith('/api/promotion/stable')) return json({ running: true })
    if (url.endsWith('/api/promotion')) return json({
      state: 'running',
      sha: 'd4a5c5f',
      startedAt: '2026-09-03T09:01:28.000Z',
      finishedAt: null,
      steps: { preflight: 'done', build: 'running', promotion: 'running' },
      events: [
        { step: 'build', status: 'running', message: 'construction des binaires release' },
        { step: 'promotion', status: 'running', message: 'Building [=======================> ] 585/587: app' },
      ],
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

  const status = await screen.findByRole('status')
  expect(status.textContent).toContain('Promotion en cours')
  expect(status.textContent).toContain('585/587')
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
