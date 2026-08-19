import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, render, screen, act } = await import('@testing-library/react')
const { useDashboard } = await import('./useDashboard')

const defaultFetch = globalThis.fetch
const DefaultSocket = globalThis.WebSocket
const defaultSetTimeout = globalThis.setTimeout
const defaultClearTimeout = globalThis.clearTimeout

class FakeSocket {
  static instances: FakeSocket[] = []
  listeners: Record<string, Array<(event: any) => void>> = {}
  closeCalls = 0

  constructor(public url: string) {
    FakeSocket.instances.push(this)
  }

  addEventListener(name: string, fn: (event: any) => void) {
    ;(this.listeners[name] ??= []).push(fn)
  }

  emit(name: string, event: any) {
    for (const fn of this.listeners[name] ?? []) fn(event)
  }

  close() {
    this.closeCalls += 1
  }
}

let nextTimerId = 0
let timers = new Map<number, () => void>()

function installFakeTimers() {
  nextTimerId = 0
  timers = new Map()
  globalThis.setTimeout = ((callback: TimerHandler) => {
    const id = ++nextTimerId
    timers.set(id, callback as () => void)
    return id as unknown as ReturnType<typeof setTimeout>
  }) as typeof setTimeout
  globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
    timers.delete(Number(id))
  }) as typeof clearTimeout
}

function runScheduledTimers() {
  const scheduled = [...timers.values()]
  timers.clear()
  for (const callback of scheduled) callback()
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve()
  })
}

afterEach(() => {
  cleanup()
  globalThis.fetch = defaultFetch
  globalThis.WebSocket = DefaultSocket
  globalThis.setTimeout = defaultSetTimeout
  globalThis.clearTimeout = defaultClearTimeout
  timers.clear()
  FakeSocket.instances = []
})

const payload = {
  projectId: 'p1',
  refreshedAt: 'now',
  integrations: [],
  tickets: [{
    id: 't1',
    key: 'TECH-1',
    title: 'Un',
    status: 'open',
    source: 'clickup',
    external_url: null,
    payload: {},
    last_seen_at: '',
    archived_at: null,
    created_at: '',
    updated_at: '',
    project_id: 'p1',
    refs: [],
    conversations: [],
    notes_count: 0,
  }],
  environments: [],
  toReview: [],
}

function Probe({ projectId = 'p1' }: { projectId?: string }) {
  const state = useDashboard(projectId)
  return createElement('div', null, `${state.connected ? 'live' : 'off'}:${state.data?.tickets.length ?? 0}`)
}

test('charge le snapshot HTTP puis suit le canal tickets', async () => {
  globalThis.fetch = mock(async () => Response.json(payload)) as typeof fetch
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket

  render(createElement(Probe))

  await screen.findByText('off:1')

  const socket = FakeSocket.instances[0]!
  expect(socket.url).toContain('/ws?channel=tickets&project=p1')

  await act(async () => {
    socket.emit('open', {})
    socket.emit('message', {
      data: JSON.stringify({
        ...payload,
        tickets: [...payload.tickets, { ...payload.tickets[0], id: 't2', key: 'TECH-2' }],
      }),
    })
  })

  await screen.findByText('live:2')
})

test('reconnecte après la fermeture du WebSocket', async () => {
  globalThis.fetch = mock(async () => Response.json(payload)) as typeof fetch
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket

  const { container } = render(createElement(Probe))
  await flushReact()
  installFakeTimers()

  const first = FakeSocket.instances[0]!
  await act(async () => {
    first.emit('close', {})
  })

  expect(first.closeCalls).toBe(1)
  expect(timers.size).toBe(1)

  await act(async () => {
    runScheduledTimers()
  })
  expect(FakeSocket.instances).toHaveLength(2)

  await act(async () => {
    FakeSocket.instances[1]!.emit('open', {})
  })
  expect(container.textContent).toBe('live:1')
})

test('reconnecte après une erreur sans doubler lorsque la fermeture suit', async () => {
  globalThis.fetch = mock(async () => Response.json(payload)) as typeof fetch
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket

  render(createElement(Probe))
  await flushReact()
  installFakeTimers()

  const first = FakeSocket.instances[0]!
  await act(async () => {
    first.emit('error', {})
    first.emit('close', {})
  })

  expect(first.closeCalls).toBe(1)
  expect(timers.size).toBe(1)

  await act(async () => {
    runScheduledTimers()
  })
  expect(FakeSocket.instances).toHaveLength(2)
})

test('annule la reconnexion et ferme le socket à l’unmount', async () => {
  globalThis.fetch = mock(async () => Response.json(payload)) as typeof fetch
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket

  const view = render(createElement(Probe))
  await flushReact()
  installFakeTimers()

  const first = FakeSocket.instances[0]!
  await act(async () => {
    first.emit('close', {})
  })
  expect(timers.size).toBe(1)

  view.unmount()
  expect(first.closeCalls).toBe(1)
  expect(timers.size).toBe(0)

  runScheduledTimers()
  expect(FakeSocket.instances).toHaveLength(1)
})

test('ferme le socket précédent et ignore ses messages au changement de projet', async () => {
  globalThis.fetch = mock(async () => Response.json(payload)) as typeof fetch
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket

  const view = render(createElement(Probe, { projectId: 'p1' }))
  await flushReact()
  const first = FakeSocket.instances[0]!

  view.rerender(createElement(Probe, { projectId: 'p2' }))
  await flushReact()

  expect(first.closeCalls).toBe(1)
  expect(FakeSocket.instances).toHaveLength(2)
  expect(FakeSocket.instances[1]!.url).toContain('project=p2')

  await act(async () => {
    first.emit('message', {
      data: JSON.stringify({
        ...payload,
        tickets: [...payload.tickets, { ...payload.tickets[0], id: 'stale' }],
      }),
    })
  })
  expect(view.container.textContent).toBe('off:1')
})

test('conserve le snapshot WS plus récent quand le HTTP initial arrive en retard', async () => {
  let resolveFetch!: (response: Response) => void
  globalThis.fetch = mock(() => new Promise<Response>((resolve) => {
    resolveFetch = resolve
  })) as typeof fetch
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket

  const { container } = render(createElement(Probe))
  const socket = FakeSocket.instances[0]!
  const older = { ...payload, refreshedAt: '2026-08-19T10:00:00.000Z' }
  const newer = {
    ...payload,
    refreshedAt: '2026-08-19T11:00:00.000Z',
    tickets: [...payload.tickets, { ...payload.tickets[0], id: 'ws-newer' }],
  }

  await act(async () => {
    socket.emit('message', { data: JSON.stringify(newer) })
  })
  expect(container.textContent).toBe('off:2')

  resolveFetch(Response.json(older))
  await flushReact()

  expect(container.textContent).toBe('off:2')
})
