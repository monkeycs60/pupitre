import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { DesignReachability } from './types'

if (typeof document === 'undefined') GlobalRegistrator.register()

/** URL que le panneau Claude Design rapporte. `null` = pas encore ouvert. */
let panelUrl: string | null = null
/** URL que la fenêtre séparée rapporte, consultée seulement si le panneau ne
 *  répond pas. Les tests qui ne s'intéressent pas au repli écrivent dans les
 *  deux via `setDockedUrl`. */
let dockedUrl: string | null = null

function setDockedUrl(url: string | null) {
  panelUrl = url
  dockedUrl = url
}

const invoked: Array<{ command: string; args: Record<string, unknown> | undefined }> = []
const invoke = mock((command: string, args?: Record<string, unknown>) => {
  invoked.push({ command, args })
  if (command === 'design_panel_url') return Promise.resolve(panelUrl)
  if (command === 'design_webview_url') return Promise.resolve(dockedUrl)
  return Promise.resolve()
})
mock.module('@tauri-apps/api/core', () => ({ invoke }))

// happy-dom n'implémente pas `ResizeObserver`, dont dépend le placement. Un
// observateur inerte suffit : les tests déclenchent le placement par le montage
// et par `resize`, jamais par une vraie variation de taille.
class InertResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as Record<string, unknown>).ResizeObserver ??= InertResizeObserver

const { cleanup, render, screen, waitFor } = await import('@testing-library/react')
const { DesignView } = await import('./DesignView')
const { resetDesignPanelSuspend, suspendDesignPanel } = await import('./designPanel')

const defaultFetch = globalThis.fetch
const defaultRect = Element.prototype.getBoundingClientRect

/** Réglages servis par le faux sidecar, et écritures qu'il a reçues. */
let storedSettings: Record<string, unknown> = {}
const settingsWrites: Array<Record<string, unknown>> = []

beforeEach(() => {
  resetDesignPanelSuspend()
})

afterEach(() => {
  cleanup()
  globalThis.fetch = defaultFetch
  Element.prototype.getBoundingClientRect = defaultRect
  invoked.length = 0
  invoke.mockClear()
  setDockedUrl(null)
  storedSettings = {}
  settingsWrites.length = 0
  resetDesignPanelSuspend()
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

/** happy-dom ne fait aucune mise en page : sans ce stub, le slot mesure zéro et
 *  le placement est légitimement abandonné. */
function stubSlotRect(rect: { left: number; top: number; right: number; bottom: number }) {
  Element.prototype.getBoundingClientRect = function stubbed(this: Element) {
    if (!this.classList.contains('design-slot')) return defaultRect.call(this)
    return {
      ...rect,
      x: rect.left,
      y: rect.top,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top,
      toJSON: () => rect,
    } as DOMRect
  }
}

const reachable: DesignReachability = {
  reachable: true,
  status: 403,
  url: 'https://claude.ai/design/',
}

function commandsUsed(): string[] {
  return invoked.map((call) => call.command)
}

function callsOf(command: string) {
  return invoked.filter((call) => call.command === command)
}

test('ouvre le panneau intégré une seule fois', async () => {
  ;(window as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  // Le sidecar reçoit un 403 même quand le panneau fonctionne : ce statut ne doit
  // jamais empêcher l'ouverture, sinon la vue reste bloquée pour de bon.
  stubReachability(reachable)

  render(createElement(DesignView))

  await waitFor(() => expect(commandsUsed()).toContain('open_design_panel'))
  expect(callsOf('open_design_panel')).toHaveLength(1)
})

test('rouvre le panneau sur la dernière page Claude Design visitée', async () => {
  ;(window as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  storedSettings = { designLastUrl: 'https://claude.ai/design/019e2187-fb46-71f4-8546-559244c11de1' }
  stubReachability(reachable)

  render(createElement(DesignView))

  await waitFor(() => expect(commandsUsed()).toContain('open_design_panel'))
  const open = callsOf('open_design_panel')[0]!
  // L'URL n'est lue qu'à la création du panneau : ouvrir avant d'avoir lu les
  // réglages condamnerait la vue à l'écran d'accueil.
  expect(open.args?.resumeUrl).toBe(storedSettings.designLastUrl)
})

test('transmet à Rust la géométrie de l’emplacement réservé', async () => {
  ;(window as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  stubReachability(reachable)
  stubSlotRect({ left: 352, top: 38, right: 1280, bottom: 760 })

  render(createElement(DesignView))

  // Tauri ne sait pas positionner une webview enfant sous Linux : sans cet appel,
  // le panneau prendrait la moitié basse de la fenêtre. Voir `design_panel.rs`.
  await waitFor(() => expect(commandsUsed()).toContain('set_design_panel_bounds'))
  expect(callsOf('set_design_panel_bounds')[0]!.args).toEqual({
    x: 352,
    y: 38,
    width: 928,
    height: 722,
  })
})

test('ne transmet pas deux fois la même géométrie', async () => {
  ;(window as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  stubReachability(reachable)
  stubSlotRect({ left: 352, top: 38, right: 1280, bottom: 760 })

  render(createElement(DesignView))
  await waitFor(() => expect(commandsUsed()).toContain('set_design_panel_bounds'))

  window.dispatchEvent(new Event('resize'))
  window.dispatchEvent(new Event('resize'))

  // Chaque appel traverse l'IPC puis une dépêche sur le thread principal de GTK.
  await waitFor(() => expect(callsOf('set_design_panel_bounds')).toHaveLength(1))
})

test('masque le panneau tant qu’un calque est ouvert', async () => {
  ;(window as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  stubReachability(reachable)
  stubSlotRect({ left: 352, top: 38, right: 1280, bottom: 760 })

  render(createElement(DesignView))
  await waitFor(() => expect(commandsUsed()).toContain('set_design_panel_bounds'))

  // Le panneau est une surface de l'OS : il se dessine au-dessus du DOM, donc la
  // palette s'ouvrirait derrière lui sans ce masquage.
  const release = suspendDesignPanel()
  await waitFor(() =>
    expect(callsOf('set_design_panel_visible').some((call) => call.args?.visible === false)).toBe(
      true,
    ),
  )

  release()
  await waitFor(() =>
    expect(callsOf('set_design_panel_visible').some((call) => call.args?.visible === true)).toBe(
      true,
    ),
  )
})

test('replace le panneau après un masquage, la zone ayant pu bouger', async () => {
  ;(window as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  stubReachability(reachable)
  stubSlotRect({ left: 352, top: 38, right: 1280, bottom: 760 })

  render(createElement(DesignView))
  await waitFor(() => expect(commandsUsed()).toContain('set_design_panel_bounds'))

  const release = suspendDesignPanel()
  await waitFor(() =>
    expect(callsOf('set_design_panel_visible').some((call) => call.args?.visible === false)).toBe(
      true,
    ),
  )
  release()
  await waitFor(() =>
    expect(callsOf('set_design_panel_visible').some((call) => call.args?.visible === true)).toBe(
      true,
    ),
  )

  // GTK n'a rien vu bouger pendant le masquage : la géométrie doit être renvoyée
  // même si elle est identique, sinon un panneau caché pendant un redimensionnement
  // revient à la mauvaise place.
  window.dispatchEvent(new Event('resize'))
  await waitFor(() => expect(callsOf('set_design_panel_bounds').length).toBeGreaterThan(1))
})

test('masque le panneau en quittant la vue', async () => {
  ;(window as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  stubReachability(reachable)
  stubSlotRect({ left: 352, top: 38, right: 1280, bottom: 760 })

  const view = render(createElement(DesignView))
  await waitFor(() => expect(commandsUsed()).toContain('open_design_panel'))

  view.unmount()

  // Sans cela, le panneau resterait posé par-dessus la vue suivante.
  await waitFor(() =>
    expect(callsOf('set_design_panel_visible').some((call) => call.args?.visible === false)).toBe(
      true,
    ),
  )
})

test('avertit qu’il faut se reconnecter quand le panneau atterrit sur la page marketing', async () => {
  ;(window as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  stubReachability(reachable)
  setDockedUrl('https://claude.com/product/design')

  render(createElement(DesignView))

  await screen.findByText(/pas connecté/i)
})

test('surveille la fenêtre séparée quand le panneau ne répond pas', async () => {
  ;(window as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  stubReachability(reachable)
  // Panneau muet, fenêtre séparée sur la page marketing : c'est exactement la
  // situation où l'utilisateur a basculé sur le repli, et il y attend la même
  // détection de session absente.
  panelUrl = null
  dockedUrl = 'https://claude.com/product/design'

  render(createElement(DesignView))

  await screen.findByText(/pas connecté/i)
})

test('ne mémorise pas la page marketing comme cible de reprise', async () => {
  ;(window as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  stubReachability(reachable)
  setDockedUrl('https://claude.com/product/design')

  render(createElement(DesignView))

  await screen.findByText(/pas connecté/i)
  // Sinon la vue rouvrirait indéfiniment sur la page marketing.
  expect(settingsWrites).toHaveLength(0)
})

test('mémorise la page atteinte quand elle est saine', async () => {
  ;(window as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  stubReachability(reachable)
  setDockedUrl('https://claude.ai/design/019e2189-400e-70eb-ad40-dde76b8042ad')

  render(createElement(DesignView))

  await waitFor(() => expect(settingsWrites.length).toBeGreaterThan(0))
  expect(settingsWrites[0]).toEqual({ designLastUrl: dockedUrl })
  expect(screen.queryByText(/pas connecté/i)).toBeNull()
})

test('signale une machine hors ligne plutôt que de blâmer le panneau', async () => {
  stubReachability({ reachable: false, message: 'Unable to connect', url: 'https://claude.ai/design/' })

  render(createElement(DesignView))

  await screen.findByText(/injoignable/i)
  expect(screen.getByText(/Unable to connect/)).toBeDefined()
})

test('offre les replis fenêtre et navigateur en permanence', async () => {
  const openInBrowser = mock(() => null)
  window.open = openInBrowser as unknown as typeof window.open
  stubReachability(reachable)

  render(createElement(DesignView))

  // Aucun preflight ne sait prédire le verdict de claude.ai, et le placement du
  // panneau dépend de la hiérarchie GTK, que Tauri ne garantit pas. Les deux
  // sorties restent donc offertes quoi qu'il arrive.
  await screen.findByRole('button', { name: /fenêtre séparée/i })
  const button = await screen.findByRole('button', { name: /navigateur/i })
  button.click()
  await waitFor(() => expect(openInBrowser).toHaveBeenCalled())
  expect(openInBrowser.mock.calls[0]![0]).toBe('https://claude.ai/design/')
})

test('masque le panneau avant d’ouvrir la fenêtre séparée', async () => {
  ;(window as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  stubReachability(reachable)

  render(createElement(DesignView))
  await waitFor(() => expect(commandsUsed()).toContain('open_design_panel'))

  const button = await screen.findByRole('button', { name: /fenêtre séparée/i })
  button.click()

  // Laisser le panneau visible superposerait deux Claude Design, dont un qui
  // recouvre l'interface de Pupitre sans qu'on puisse l'atteindre.
  await waitFor(() => expect(commandsUsed()).toContain('open_design_window'))
  expect(callsOf('set_design_panel_visible').some((call) => call.args?.visible === false)).toBe(true)
})

test('ferme les popups vides une fois le flux de connexion terminé', async () => {
  ;(window as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  stubReachability(reachable)
  setDockedUrl('https://claude.ai/design/019e2189-400e-70eb-ad40-dde76b8042ad')

  render(createElement(DesignView))

  // wry répond au window.close() de fin d'OAuth par un webview.destroy() seul :
  // la fenêtre reste affichée, vide, jusqu'à ce qu'on la ferme.
  await waitFor(() => expect(commandsUsed()).toContain('close_design_popups'))
  expect(callsOf('close_design_popups')).toHaveLength(1)
})

test('ne ferme aucune popup pendant que la connexion est en cours', async () => {
  ;(window as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  stubReachability(reachable)
  // Page marketing : la session manque, une popup peut être en pleine
  // authentification et la fermer casserait le flux.
  setDockedUrl('https://claude.com/product/design')

  render(createElement(DesignView))

  await screen.findByText(/pas connecté/i)
  expect(commandsUsed()).not.toContain('close_design_popups')
})
