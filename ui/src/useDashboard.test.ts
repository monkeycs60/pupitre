import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, render, screen, act } = await import('@testing-library/react')
const { useDashboard } = await import('./useDashboard')

const defaultFetch = globalThis.fetch
const DefaultSocket = globalThis.WebSocket

class FakeSocket {
  static instances: FakeSocket[] = []
  listeners: Record<string, Array<(event: any) => void>> = {}

  constructor(public url: string) {
    FakeSocket.instances.push(this)
  }

  addEventListener(name: string, fn: (event: any) => void) {
    ;(this.listeners[name] ??= []).push(fn)
  }

  emit(name: string, event: any) {
    for (const fn of this.listeners[name] ?? []) fn(event)
  }

  close() {}
}

afterEach(() => {
  cleanup()
  globalThis.fetch = defaultFetch
  globalThis.WebSocket = DefaultSocket
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

function Probe() {
  const state = useDashboard('p1')
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
