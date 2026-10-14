import { afterEach, describe, expect, test } from 'bun:test'
import { isAppRestartShortcut, sidecarResponds } from './appRestart'

function key(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    altKey: false,
    ctrlKey: false,
    key: 'r',
    metaKey: false,
    shiftKey: false,
    ...overrides,
  } as KeyboardEvent
}

describe('raccourci de redémarrage', () => {
  test('accepte Ctrl/Cmd + Maj + R', () => {
    expect(isAppRestartShortcut(key({ ctrlKey: true, shiftKey: true }))).toBe(true)
    expect(isAppRestartShortcut(key({ metaKey: true, shiftKey: true, key: 'R' }))).toBe(true)
  })

  test('laisse Ctrl+R et Alt+Ctrl+Maj+R au moteur de la webview', () => {
    expect(isAppRestartShortcut(key({ ctrlKey: true }))).toBe(false)
    expect(isAppRestartShortcut(key({ altKey: true, ctrlKey: true, shiftKey: true }))).toBe(false)
  })
})

describe('sonde du sidecar', () => {
  const realFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = realFetch })

  test('répond oui quand /api/health répond', async () => {
    globalThis.fetch = (async () => Response.json({ ok: true })) as unknown as typeof fetch
    expect(await sidecarResponds()).toBe(true)
  })

  test('répond non quand le sidecar refuse la connexion', async () => {
    globalThis.fetch = (async () => { throw new TypeError('Failed to fetch') }) as unknown as typeof fetch
    expect(await sidecarResponds()).toBe(false)
  })

  test('répond non quand le sidecar se tait au-delà du délai', async () => {
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
    })) as unknown as typeof fetch
    expect(await sidecarResponds(20)).toBe(false)
  })
})
