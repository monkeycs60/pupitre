import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { DesignReachability } from './types'

if (typeof document === 'undefined') GlobalRegistrator.register()

/** URL que la webview dockée rapporte. `null` = pas encore créée. */
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

afterEach(() => {
  cleanup()
  globalThis.fetch = defaultFetch
  invoked.length = 0
  invoke.mockClear()
  dockedUrl = null
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

const reachable: DesignReachability = {
  reachable: true,
  status: 403,
  url: 'https://claude.ai/design/',
}

function commandsUsed(): string[] {
  return invoked.map((call) => call.command)
}

test('docke la webview sur le rectangle réservé et la masque au démontage', async () => {
  ;(window as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  stubReachability(reachable)

  const view = render(createElement(DesignView))

  await waitFor(() => expect(commandsUsed()).toContain('dock_design_webview'))
  const dock = invoked.find((call) => call.command === 'dock_design_webview')!
  for (const key of ['x', 'y', 'width', 'height']) {
    expect(typeof dock.args?.[key]).toBe('number')
  }

  view.unmount()
  // Masquer et non détruire : recréer la webview rechargerait claude.ai et
  // ferait perdre le travail en cours dans Claude Design.
  await waitFor(() => expect(commandsUsed()).toContain('hide_design_webview'))
  expect(commandsUsed()).not.toContain('open_design_window')
})

test('masque la webview quand un overlay de l’application est ouvert', async () => {
  ;(window as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  stubReachability(reachable)

  render(createElement(DesignView, { suspended: true }))

  // Une webview est une surface de l'OS : sans ce masquage, la palette Ctrl+K
  // s'ouvrirait derrière elle.
  await waitFor(() => expect(commandsUsed()).toContain('hide_design_webview'))
  expect(commandsUsed()).not.toContain('dock_design_webview')
})

test('avertit qu’il faut se reconnecter quand la webview atterrit sur la page marketing', async () => {
  ;(window as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  stubReachability(reachable)
  dockedUrl = 'https://claude.com/product/design'

  render(createElement(DesignView))

  await screen.findByText(/pas connecté/i)
})

test('reste silencieux quand la webview est bien sur claude.ai', async () => {
  ;(window as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  stubReachability(reachable)
  dockedUrl = 'https://claude.ai/design/'

  render(createElement(DesignView))

  await waitFor(() => expect(commandsUsed()).toContain('design_webview_url'))
  expect(screen.queryByText(/pas connecté/i)).toBeNull()
})

test('signale une machine hors ligne plutôt que de blâmer la webview', async () => {
  stubReachability({ reachable: false, message: 'Unable to connect', url: 'https://claude.ai/design/' })

  render(createElement(DesignView))

  await screen.findByText(/injoignable/i)
  expect(screen.getByText(/Unable to connect/)).toBeDefined()
})
