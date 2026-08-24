import { afterEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, render, act } = await import('@testing-library/react')
const { useTimeTracking } = await import('./useTimeTracking')

const defaultFetch = globalThis.fetch
const defaultSetInterval = globalThis.setInterval
const defaultNow = Date.now

let intervals: Array<{ fn: () => void; ms: number }> = []
let clock = Date.parse('2026-08-24T09:00:00.000Z')
let posted: Array<Record<string, unknown>> = []

const EMPTY_SNAPSHOT = {
  scope: 'project', projectId: 'p1', projectCount: 1,
  user: { ms: 0, level: 0, levelMs: 0, progress: 0, todayMs: 0 },
  agent: { ms: 0, level: 0, levelMs: 0, progress: 0, todayMs: 0 },
  supervisionMs: 0, writingMs: 0, agentAloneMs: 0,
  weekUserMs: 0, weekAgentMs: 0, previousWeekUserMs: 0,
  activeDays: 0, commits: 0, turnCount: 0, backfilledMs: 0,
  nextMilestone: 10, msToNextMilestone: 36_000_000,
  milestones: [], projects: [], conversations: {}, turns: {},
}

function install({ visible = true, focused = true }: { visible?: boolean; focused?: boolean } = {}) {
  intervals = []
  posted = []
  clock = Date.parse('2026-08-24T09:00:00.000Z')
  Date.now = () => clock
  globalThis.setInterval = ((fn: () => void, ms: number) => {
    intervals.push({ fn, ms })
    return intervals.length as unknown as ReturnType<typeof setInterval>
  }) as typeof setInterval
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (visible ? 'visible' : 'hidden'),
  })
  document.hasFocus = () => focused
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/time/presence')) {
      posted.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    return new Response(JSON.stringify(EMPTY_SNAPSHOT), { status: 200 })
  }) as typeof fetch
}

/** Avance l'horloge et déclenche les ticks d'une seconde. */
async function tick(seconds: number) {
  for (let index = 0; index < seconds; index += 1) {
    clock += 1_000
    await act(async () => {
      for (const entry of intervals) if (entry.ms === 1_000) entry.fn()
      await Promise.resolve()
    })
  }
}

afterEach(() => {
  cleanup()
  globalThis.fetch = defaultFetch
  globalThis.setInterval = defaultSetInterval
  Date.now = defaultNow
  intervals = []
})

function mount(projectId: string | null, conversationId: string | null = null) {
  let value: ReturnType<typeof useTimeTracking> | null = null
  function Probe() {
    value = useTimeTracking(projectId, conversationId)
    return null
  }
  render(createElement(Probe))
  return () => value
}

test('une fenêtre visible et active envoie une tranche de présence au bout de quinze secondes', async () => {
  install()
  mount('p1', 'c1')
  await act(async () => { await Promise.resolve() })
  await tick(16)
  expect(posted.length).toBe(1)
  const slice = posted[0] as { projectId: string; conversationId: string; startedAt: string; endedAt: string }
  expect(slice.projectId).toBe('p1')
  expect(slice.conversationId).toBe('c1')
  const duration = Date.parse(slice.endedAt) - Date.parse(slice.startedAt)
  expect(duration).toBeGreaterThanOrEqual(15_000)
  expect(duration).toBeLessThanOrEqual(17_000)
})

test('un onglet caché ne fait rien remonter', async () => {
  install({ visible: false })
  mount('p1')
  await act(async () => { await Promise.resolve() })
  await tick(40)
  expect(posted).toEqual([])
})

test('une fenêtre au second plan ne fait rien remonter', async () => {
  install({ focused: false })
  mount('p1')
  await act(async () => { await Promise.resolve() })
  await tick(40)
  expect(posted).toEqual([])
})

test('sans projet sélectionné, rien n’est imputé', async () => {
  install()
  mount(null)
  await act(async () => { await Promise.resolve() })
  await tick(40)
  expect(posted).toEqual([])
})

test('le mode est mémorisé par projet', async () => {
  install()
  const read = mount('p1')
  await act(async () => { await Promise.resolve() })
  expect(read()?.mode).toBe('user')
  await act(async () => { read()?.toggleMode() })
  expect(read()?.mode).toBe('agent')
  expect(window.localStorage.getItem('pupitre:time-mode:p1')).toBe('agent')

  cleanup()
  const other = mount('p2')
  await act(async () => { await Promise.resolve() })
  expect(other()?.mode).toBe('user')

  cleanup()
  const again = mount('p1')
  await act(async () => { await Promise.resolve() })
  expect(again()?.mode).toBe('agent')
})
