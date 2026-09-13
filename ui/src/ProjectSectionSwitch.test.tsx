import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const {
  projectNavigationIndexForShortcut,
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
    'Conversation', 'Tickets', 'Sentry', 'Changelog', 'Environnements', 'Tâches 2',
  ])

  fireEvent.keyDown(screen.getByRole('tab', { name: 'Conversation' }), { key: 'ArrowRight' })
  expect(onSelect).toHaveBeenCalledWith('tickets')
  expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Tickets' }))
})

test('utilise le code physique des chiffres pour fonctionner sur AZERTY', () => {
  expect(projectNavigationIndexForShortcut({ ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, code: 'Digit2' })).toBe(1)
  expect(projectNavigationIndexForShortcut({ ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, code: 'Numpad6' })).toBe(5)
  expect(projectNavigationIndexForShortcut({ ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, code: 'Digit3' })).toBeNull()
})
