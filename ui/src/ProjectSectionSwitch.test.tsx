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

test('rend les quatre sections du projet en texte et les parcourt au clavier', async () => {
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
  expect(tabs).toHaveLength(4)
  expect(tabs.map((tab) => tab.getAttribute('aria-label'))).toEqual([
    'Conversations', 'Tickets', 'Tâches 2', 'Sentry',
  ])
  expect(tabs[0]!.getAttribute('aria-selected')).toBe('true')

  fireEvent.keyDown(screen.getByRole('tab', { name: 'Conversations' }), { key: 'ArrowRight' })
  expect(onSelect).toHaveBeenCalledWith('tickets')
  expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Tickets' }))
})

test('utilise le code physique des chiffres pour fonctionner sur AZERTY', () => {
  expect(projectNavigationIndexForShortcut({ ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, code: 'Digit2' })).toBe(1)
  expect(projectNavigationIndexForShortcut({ ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, code: 'Numpad4' })).toBe(3)
  expect(projectNavigationIndexForShortcut({ ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, code: 'Digit5' })).toBeNull()
  expect(projectNavigationIndexForShortcut({ ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, code: 'Digit3' })).toBeNull()
})
