import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const {
  storeProjectLayout,
  storedProjectLayout,
} = await import('./projectSections')
const { ProjectSectionSwitch } = await import('./ProjectSectionSwitch')

const defaultFetch = globalThis.fetch
const DefaultSocket = globalThis.WebSocket

class SilentSocket {
  addEventListener() {}
  close() {}
}

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  globalThis.fetch = defaultFetch
  globalThis.WebSocket = DefaultSocket
})

test('rend six destinations et les parcourt au clavier', async () => {
  globalThis.fetch = mock(async (input) => Response.json(String(input).includes('/sentry')
    ? { issues: [] }
    : { integrations: [], tickets: [] })) as typeof fetch
  globalThis.WebSocket = SilentSocket as unknown as typeof WebSocket
  const onSelect = mock(() => {})

  render(createElement(ProjectSectionSwitch, {
    projectId: 'p1',
    activeSection: null,
    todoCount: 2,
    onSelect,
  }))

  await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled())

  const tabs = screen.getAllByRole('tab')
  expect(tabs).toHaveLength(6)
  expect(tabs.map((tab) => tab.getAttribute('aria-label'))).toEqual([
    'Conversation', 'Tâches 2', 'Tickets', 'Sentry', 'Changelog', 'Environnements',
  ])

  fireEvent.keyDown(screen.getByRole('tab', { name: 'Conversation' }), { key: 'ArrowRight' })
  expect(onSelect).toHaveBeenCalledWith('todos')
  expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Tâches 2' }))
})

test('mémorise une disposition par projet et par section', () => {
  expect(storedProjectLayout('p1', 'todos')).toBe('docked')
  expect(storedProjectLayout('p1', 'tickets')).toBe('full')

  storeProjectLayout('p1', 'tickets', 'docked')

  expect(storedProjectLayout('p1', 'tickets')).toBe('docked')
  expect(storedProjectLayout('p2', 'tickets')).toBe('full')
})
