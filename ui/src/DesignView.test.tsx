import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { DesignReachability } from './types'

if (typeof document === 'undefined') GlobalRegistrator.register()

/** URL que la fenêtre Claude Design rapporte. `null` = pas encore ouverte. */
let dockedUrl: string | null = null

const invoked: Array<{ command: string; args: Record<string, unknown> | undefined }> = []
const invoke = mock((command: string, args?: Record<string, unknown>) => {
  invoked.push({ command, args })
  if (command === 'design_webview_url') return Promise.resolve(dockedUrl)
  return Promise.resolve()
})
mock.module('@tauri-apps/api/core', () => ({ invoke }))

const { cleanup, render, screen, waitFor } = await import('@testing-library/react')
const { DesignView } = await import('./DesignView')

const defaultFetch = globalThis.fetch

/** Réglages servis par le faux sidecar, et écritures qu'il a reçues. */
let storedSettings: Record<string, unknown> = {}
const settingsWrites: Array<Record<string, unknown>> = []

afterEach(() => {
  cleanup()
  globalThis.fetch = defaultFetch
  invoked.length = 0
  invoke.mockClear()
  dockedUrl = null
  storedSettings = {}
  settingsWrites.length = 0
  delete (window as Record<string, unknown>).__TAURI_INTERNALS__
})

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function stubReachability(reachability: DesignReachability) {
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.includes('/api/design/reachability')) return json(reachability)
    if (url.includes('/api/settings')) {
      if ((init?.method ?? 'GET') === 'GET') return json(storedSettings)
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      settingsWrites.push(body)
      storedSettings = { ...storedSettings, ...body }
      return json(storedSettings)
    }
    throw new Error(`route inattendue : ${url}`)
  }) as unknown as typeof fetch
}

const reachable: DesignReachability = {
  reachable: true,
  status: 403,
  url: 'https://claude.ai/design/',
}

function commandsUsed(): string[] {
  return invoked.map((call) => call.command)
}

test('ouvre la fenêtre dédiée une seule fois', async () => {
  ;(window as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  // Le sidecar reçoit un 403 même quand la fenêtre fonctionne : ce statut ne doit
  // jamais empêcher l'ouverture, sinon la vue reste bloquée pour de bon.
  stubReachability(reachable)

  render(createElement(DesignView))

  await waitFor(() => expect(commandsUsed()).toContain('open_design_window'))
  expect(commandsUsed().filter((command) => command === 'open_design_window')).toHaveLength(1)
  await screen.findByText(/Fenêtre ouverte/i)
})

test('rouvre la fenêtre sur la dernière page Claude Design visitée', async () => {
  ;(window as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  storedSettings = { designLastUrl: 'https://claude.ai/design/019e2187-fb46-71f4-8546-559244c11de1' }
  stubReachability(reachable)

  render(createElement(DesignView))

  await waitFor(() => expect(commandsUsed()).toContain('open_design_window'))
  const open = invoked.find((call) => call.command === 'open_design_window')!
  // L'URL n'est lue qu'à la création de la fenêtre : ouvrir avant d'avoir lu les
  // réglages condamnerait la vue à l'écran d'accueil.
  expect(open.args?.resumeUrl).toBe(storedSettings.designLastUrl)
})

test('avertit qu’il faut se reconnecter quand la fenêtre atterrit sur la page marketing', async () => {
  ;(window as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  stubReachability(reachable)
  dockedUrl = 'https://claude.com/product/design'

  render(createElement(DesignView))

  await screen.findByText(/pas connecté/i)
})

test('ne mémorise pas la page marketing comme cible de reprise', async () => {
  ;(window as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  stubReachability(reachable)
  dockedUrl = 'https://claude.com/product/design'

  render(createElement(DesignView))

  await screen.findByText(/pas connecté/i)
  // Sinon la vue rouvrirait indéfiniment sur la page marketing.
  expect(settingsWrites).toHaveLength(0)
})

test('mémorise la page atteinte quand elle est saine', async () => {
  ;(window as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  stubReachability(reachable)
  dockedUrl = 'https://claude.ai/design/019e2189-400e-70eb-ad40-dde76b8042ad'

  render(createElement(DesignView))

  await waitFor(() => expect(settingsWrites.length).toBeGreaterThan(0))
  expect(settingsWrites[0]).toEqual({ designLastUrl: dockedUrl })
  expect(screen.queryByText(/pas connecté/i)).toBeNull()
})

test('signale une machine hors ligne plutôt que de blâmer la fenêtre', async () => {
  stubReachability({ reachable: false, message: 'Unable to connect', url: 'https://claude.ai/design/' })

  render(createElement(DesignView))

  await screen.findByText(/injoignable/i)
  expect(screen.getByText(/Unable to connect/)).toBeDefined()
})

test('offre le repli navigateur en permanence', async () => {
  const openInBrowser = mock(() => null)
  window.open = openInBrowser as unknown as typeof window.open
  stubReachability(reachable)

  render(createElement(DesignView))

  await screen.findByText(/Si la fenêtre affiche une erreur/i)
  const button = await screen.findByRole('button', { name: /navigateur/i })
  button.click()
  await waitFor(() => expect(openInBrowser).toHaveBeenCalled())
  expect(openInBrowser.mock.calls[0]![0]).toBe('https://claude.ai/design/')
})

test('ferme les popups vides une fois le flux de connexion terminé', async () => {
  ;(window as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  stubReachability(reachable)
  dockedUrl = 'https://claude.ai/design/019e2189-400e-70eb-ad40-dde76b8042ad'

  render(createElement(DesignView))

  // wry répond au window.close() de fin d'OAuth par un webview.destroy() seul :
  // la fenêtre reste affichée, vide, jusqu'à ce qu'on la ferme.
  await waitFor(() => expect(commandsUsed()).toContain('close_design_popups'))
  expect(commandsUsed().filter((command) => command === 'close_design_popups')).toHaveLength(1)
})

test('ne ferme aucune popup pendant que la connexion est en cours', async () => {
  ;(window as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  stubReachability(reachable)
  // Page marketing : la session manque, une popup peut être en pleine
  // authentification et la fermer casserait le flux.
  dockedUrl = 'https://claude.com/product/design'

  render(createElement(DesignView))

  await screen.findByText(/pas connecté/i)
  expect(commandsUsed()).not.toContain('close_design_popups')
})
