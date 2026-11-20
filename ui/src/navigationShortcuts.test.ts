import { expect, test } from 'bun:test'
import { isPreviousConversationShortcut, isRecentConversationsShortcut, navigationViewForShortcut, NAVIGATION_SHORTCUTS } from './navigationShortcuts'

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

test('Ctrl Maj L ouvre les lues récemment et Ctrl Tab seul rappelle la conversation précédente', () => {
  expect(isRecentConversationsShortcut(key({ ctrlKey: true, shiftKey: true, key: 'L' }))).toBe(true)
  expect(isRecentConversationsShortcut(key({ ctrlKey: true, key: 'l' }))).toBe(false)
  expect(navigationViewForShortcut(key({ ctrlKey: true, shiftKey: true, key: 'L' }))).toBeNull()
  expect(isPreviousConversationShortcut(key({ ctrlKey: true, key: 'Tab' }))).toBe(true)
  expect(isPreviousConversationShortcut(key({ ctrlKey: true, shiftKey: true, key: 'Tab' }))).toBe(false)
  expect(isPreviousConversationShortcut(key({ key: 'Tab' }))).toBe(false)
})
