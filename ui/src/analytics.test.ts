import { afterEach, beforeEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { UiEventPayload } from './api'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { ApiError } = await import('./api')
const { createUsageTracker, track, USAGE_BATCH_MAX, USAGE_BUFFER_MAX, USAGE_FLUSH_MS } = await import('./analytics')

const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
const realFetch = globalThis.fetch
let timers: Array<{ id: number; fn: () => void; ms: number }> = []
let nextTimer = 0
let visibility: DocumentVisibilityState = 'visible'

beforeEach(() => {
  timers = []
  visibility = 'visible'
  globalThis.setTimeout = ((fn: () => void, ms: number) => {
    nextTimer += 1
    timers.push({ id: nextTimer, fn, ms })
    return nextTimer
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((id: number) => {
    timers = timers.filter((timer) => timer.id !== id)
  }) as typeof clearTimeout
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
})

afterEach(() => {
  globalThis.setTimeout = realSetTimeout
  globalThis.clearTimeout = realClearTimeout
  globalThis.fetch = realFetch
  Reflect.deleteProperty(document, 'visibilityState')
})

const settle = () => new Promise((resolve) => realSetTimeout(resolve, 0))

function runTimers() {
  const due = timers
  timers = []
  for (const timer of due) timer.fn()
}

function recorder(failure: () => unknown = () => null) {
  const sent: Array<{ events: UiEventPayload[]; keepalive: boolean }> = []
  const tracker = createUsageTracker(async (events, keepalive) => {
    sent.push({ events, keepalive })
    const error = failure()
    if (error) throw error
  })
  return { sent, tracker }
}

test('les événements partent groupés au bout de 10 s, avec leur heure, leur projet et leurs propriétés', async () => {
  const { sent, tracker } = recorder()
  tracker.track('project.tab', { tab: 'tickets' }, 'p1')
  tracker.track('nav.report')
  expect(sent).toEqual([])
  expect(timers.map((timer) => timer.ms)).toEqual([USAGE_FLUSH_MS])

  runTimers()
  await settle()

  expect(sent).toHaveLength(1)
  expect(sent[0]!.keepalive).toBe(false)
  expect(sent[0]!.events).toEqual([
    { at: expect.any(String), name: 'project.tab', projectId: 'p1', props: { tab: 'tickets' } },
    { at: expect.any(String), name: 'nav.report' },
  ])
  expect(sent[0]!.events.every((event) => new Date(event.at).toISOString() === event.at)).toBe(true)
  expect(tracker.pending()).toBe(0)
  expect(timers).toEqual([])
})

test('un tampon plein garde les 500 plus récents et part en lots de 200 au plus', async () => {
  const { sent, tracker } = recorder()
  for (let index = 0; index < USAGE_BUFFER_MAX + 20; index += 1) tracker.track('shortcut', { key: `k${index}` })
  expect(tracker.pending()).toBe(USAGE_BUFFER_MAX)

  tracker.flush()
  await settle()

  expect(sent.map((call) => call.events.length)).toEqual([USAGE_BATCH_MAX, USAGE_BATCH_MAX, USAGE_BUFFER_MAX - 2 * USAGE_BATCH_MAX])
  expect(sent[0]!.events[0]!.props).toEqual({ key: 'k20' })
  expect(sent.at(-1)!.events.at(-1)!.props).toEqual({ key: `k${USAGE_BUFFER_MAX + 19}` })
})

test('une page cachée ou quittée envoie tout de suite en keepalive, une page visible attend', async () => {
  const { sent, tracker } = recorder()
  tracker.track('composer.send')
  document.dispatchEvent(new Event('visibilitychange'))
  await settle()
  expect(sent).toEqual([])

  visibility = 'hidden'
  document.dispatchEvent(new Event('visibilitychange'))
  await settle()
  expect(sent).toEqual([{ events: [expect.objectContaining({ name: 'composer.send' })], keepalive: true }])
  expect(timers).toEqual([])

  tracker.track('thread.search')
  window.dispatchEvent(new Event('pagehide'))
  await settle()
  expect(sent[1]).toEqual({ events: [expect.objectContaining({ name: 'thread.search' })], keepalive: true })
})

test('un échec réseau ou serveur remet le lot en file, un refus 4xx l’abandonne', async () => {
  let failure: unknown = new TypeError('Failed to fetch')
  const { sent, tracker } = recorder(() => failure)
  tracker.track('servers.restart')
  tracker.flush()
  await settle()
  expect(tracker.pending()).toBe(1)
  expect(timers).toHaveLength(1)

  failure = new ApiError(503, 'sidecar en redémarrage')
  runTimers()
  await settle()
  expect(tracker.pending()).toBe(1)

  failure = new ApiError(400, 'corps JSON invalide')
  runTimers()
  await settle()
  expect(tracker.pending()).toBe(0)
  expect(timers).toEqual([])
  expect(sent).toHaveLength(3)
})

test('track ne lève jamais, même quand l’envoi ou le minuteur échouent sur-le-champ', async () => {
  const tracker = createUsageTracker(() => { throw new TypeError('fetch indisponible') })
  tracker.track('servers.logs')
  expect(() => tracker.flush()).not.toThrow()
  await settle()
  expect(tracker.pending()).toBe(1)

  globalThis.setTimeout = (() => { throw new Error('minuteur indisponible') }) as unknown as typeof setTimeout
  expect(() => tracker.track('servers.open')).not.toThrow()
  expect(() => track('nav.settings')).not.toThrow()
})

test('track envoie au sidecar par POST /api/ui-events, en keepalive quand la page se ferme', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return new Response(null, { status: 204 })
  }) as typeof fetch

  track('design.open', undefined, 'p2')
  window.dispatchEvent(new Event('pagehide'))
  await settle()

  const sent = calls.filter((call) => call.url.endsWith('/api/ui-events'))
  expect(sent).toHaveLength(1)
  expect(sent[0]!.init).toMatchObject({ method: 'POST', keepalive: true })
  expect(JSON.parse(String(sent[0]!.init!.body)).events).toEqual(expect.arrayContaining([
    { at: expect.any(String), name: 'design.open', projectId: 'p2' },
  ]))
})
