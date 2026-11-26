import { afterEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { DEFAULT_ACTION_FORMAT } from './actionHeadings'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, renderHook, waitFor } = await import('@testing-library/react')
const { useActionFormat } = await import('./useActionFormat')

const originalFetch = globalThis.fetch

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

test('les intitulés personnalisés s’appliquent même si les réglages ne répondent pas au premier essai', async () => {
  let settingsReads = 0
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (!String(input).endsWith('/api/settings')) throw new TypeError('inattendu')
    settingsReads += 1
    return settingsReads === 1
      ? json({ error: 'démarrage' }, 500)
      : json({ actionFormat: { todoHeadings: ['À TOI'] } })
  }) as typeof fetch

  const { result } = renderHook(() => useActionFormat())

  expect(result.current).toEqual(DEFAULT_ACTION_FORMAT)
  await waitFor(() => expect(result.current.todoHeadings).toEqual(['À TOI']), { timeout: 3_000 })
  expect(result.current.followUpHeadings).toEqual(DEFAULT_ACTION_FORMAT.followUpHeadings)
  expect(settingsReads).toBe(2)
})
