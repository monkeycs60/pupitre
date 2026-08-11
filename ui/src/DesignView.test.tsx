import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { DesignAccess } from './types'

if (typeof document === 'undefined') GlobalRegistrator.register()

const openWindow = mock(() => Promise.resolve())
mock.module('@tauri-apps/api/core', () => ({ invoke: openWindow }))

const { cleanup, fireEvent, screen, waitFor } = await import('@testing-library/react')
const { render } = await import('@testing-library/react')
const { DesignView } = await import('./DesignView')

const defaultFetch = globalThis.fetch

afterEach(() => {
  cleanup()
  globalThis.fetch = defaultFetch
  openWindow.mockClear()
  delete (window as Record<string, unknown>).__TAURI_INTERNALS__
})

function stubAccess(access: DesignAccess): ReturnType<typeof mock> {
  const calls = mock((input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input)
    if (!url.includes('/api/design/access')) throw new Error(`route inattendue : ${url}`)
    return Promise.resolve(new Response(JSON.stringify(access), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
  })
  globalThis.fetch = calls as unknown as typeof fetch
  return calls
}

test('ouvre la fenêtre dédiée une seule fois quand claude.ai accepte la webview', async () => {
  ;(window as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  stubAccess({ ok: true, status: 200, url: 'https://claude.ai/design/' })

  render(createElement(DesignView))

  await waitFor(() => expect(openWindow).toHaveBeenCalledTimes(1))
  expect(openWindow.mock.calls[0]![0]).toBe('open_design_window')
  await screen.findByText(/fenêtre dédiée/i)
})

test('affiche le refus de webview et propose le navigateur sans tenter la fenêtre', async () => {
  const openInBrowser = mock(() => null)
  window.open = openInBrowser as unknown as typeof window.open
  stubAccess({ ok: false, reason: 'ua-refused', status: 403, url: 'https://claude.ai/design/' })

  render(createElement(DesignView))

  await screen.findByText(/Claude Design a refusé la webview/i)
  // Le repli n'a de sens que si la fenêtre n'est jamais ouverte sur un 403 :
  // sinon l'utilisateur voit le JSON d'erreur brut de claude.ai.
  expect(openWindow).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: /navigateur/i }))
  expect(openInBrowser).toHaveBeenCalled()
  expect(openInBrowser.mock.calls[0]![0]).toBe('https://claude.ai/design/')
})

test('distingue une panne réseau du refus et permet de refaire le test', async () => {
  const calls = stubAccess({
    ok: false,
    reason: 'unreachable',
    status: null,
    message: 'Unable to connect',
    url: 'https://claude.ai/design/',
  })

  render(createElement(DesignView))

  await screen.findByText(/injoignable/i)
  expect(screen.queryByText(/refusé la webview/i)).toBeNull()
  expect(openWindow).not.toHaveBeenCalled()

  const before = calls.mock.calls.length
  fireEvent.click(screen.getByRole('button', { name: /réessayer/i }))
  await waitFor(() => expect(calls.mock.calls.length).toBeGreaterThan(before))
})
