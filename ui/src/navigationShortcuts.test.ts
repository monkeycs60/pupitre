import { expect, test } from 'bun:test'
import { navigationViewForShortcut, NAVIGATION_SHORTCUTS } from './navigationShortcuts'

function key(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    altKey: false,
    ctrlKey: false,
    key: '',
    metaKey: false,
    shiftKey: false,
    ...overrides,
  } as KeyboardEvent
}

test('associe Ctrl+Maj aux cinq vues de travail par leur lettre', () => {
  expect(NAVIGATION_SHORTCUTS.map(({ view, label }) => [view, label])).toEqual([
    ['conversations', 'Ctrl Maj C'],
    ['fleet', 'Ctrl Maj F'],
    ['dashboard', 'Ctrl Maj T'],
    ['documents', 'Ctrl Maj D'],
    ['design', 'Ctrl Maj G'],
  ])
  expect(navigationViewForShortcut(key({ ctrlKey: true, shiftKey: true, key: 'T' }))).toBe('dashboard')
  expect(navigationViewForShortcut(key({ ctrlKey: true, key: 't' }))).toBeNull()
  expect(navigationViewForShortcut(key({ ctrlKey: true, altKey: true, shiftKey: true, key: 't' }))).toBeNull()
})
