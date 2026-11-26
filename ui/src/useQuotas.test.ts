import { afterEach, beforeEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, renderHook, waitFor } = await import('@testing-library/react')
const { useQuotas } = await import('./useQuotas')

const originalFetch = globalThis.fetch
const settings = {
  quotaVisibleProviders: ['codex', 'claude'],
  quotaProviderOrder: ['codex', 'claude', 'grok', 'reasonix'],
  quotaThresholds: { lastHour: true, usedPercent: 90 },
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

test('les jauges masquées restent masquées quand les réglages ne répondent pas au premier essai', async () => {
  let settingsReads = 0
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/api/settings')) {
      settingsReads += 1
      return settingsReads === 1 ? json({ error: 'démarrage' }, 500) : json(settings)
    }
    if (url.endsWith('/api/quotas')) return json({})
    throw new TypeError('inattendu')
  }) as typeof fetch

  const { result } = renderHook(() => useQuotas())

  await waitFor(() => expect(result.current.visibleProviders).toEqual(['codex', 'claude']), { timeout: 3_000 })
  expect(settingsReads).toBeGreaterThan(1)
})

test('au lancement, la barre reprend les jauges du dernier affichage en attendant le sidecar', () => {
  localStorage.setItem('pupitre.quota-displayed-providers', JSON.stringify(['codex', 'claude']))
  globalThis.fetch = (() => new Promise<Response>(() => {})) as unknown as typeof fetch

  const { result } = renderHook(() => useQuotas())

  expect(result.current.visibleProviders).toEqual(['codex', 'claude'])
})
