import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { DesignReachability } from './types'

if (typeof document === 'undefined') GlobalRegistrator.register()

const openWindow = mock(() => Promise.resolve())
mock.module('@tauri-apps/api/core', () => ({ invoke: openWindow }))

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { DesignView } = await import('./DesignView')

const defaultFetch = globalThis.fetch

afterEach(() => {
  cleanup()
  globalThis.fetch = defaultFetch
  openWindow.mockClear()
  delete (window as Record<string, unknown>).__TAURI_INTERNALS__
})

function stubReachability(reachability: DesignReachability) {
  globalThis.fetch = mock((input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input)
    if (!url.includes('/api/design/reachability')) throw new Error(`route inattendue : ${url}`)
    return Promise.resolve(new Response(JSON.stringify(reachability), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
  }) as unknown as typeof fetch
}

test("ouvre la fenêtre dédiée une seule fois, sans attendre d'autorisation", async () => {
  ;(window as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  // Le sidecar reçoit un 403 même quand la webview fonctionne : ce statut ne
  // doit jamais empêcher l'ouverture, sinon la fenêtre est bloquée pour de bon.
  stubReachability({ reachable: true, status: 403, url: 'https://claude.ai/design/' })

  render(createElement(DesignView))

  await waitFor(() => expect(openWindow).toHaveBeenCalledTimes(1))
  expect(openWindow.mock.calls[0]![0]).toBe('open_design_window')
  await screen.findByText(/Fenêtre ouverte/i)
})

test('offre en permanence le repli navigateur sur la cible testée', async () => {
  const openInBrowser = mock(() => null)
  window.open = openInBrowser as unknown as typeof window.open
  stubReachability({ reachable: true, status: 200, url: 'https://claude.ai/design/' })

  render(createElement(DesignView))

  await screen.findByText(/Si la fenêtre affiche une erreur/i)
  fireEvent.click(screen.getByRole('button', { name: /navigateur/i }))
  expect(openInBrowser).toHaveBeenCalled()
  expect(openInBrowser.mock.calls[0]![0]).toBe('https://claude.ai/design/')
})

test('signale une machine hors ligne plutôt que de blâmer la webview', async () => {
  stubReachability({ reachable: false, message: 'Unable to connect', url: 'https://claude.ai/design/' })

  render(createElement(DesignView))

  await screen.findByText(/injoignable/i)
  expect(screen.getByText(/Unable to connect/)).toBeDefined()
})
