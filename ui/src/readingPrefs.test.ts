import { expect, test } from 'bun:test'
import { clampZoom, readingZoomShortcut } from './readingPrefs'

test('borne le zoom de lecture entre 70 % et 200 % au dixième près', () => {
  expect(clampZoom(0.5)).toBe(0.7)
  expect(clampZoom(2.4)).toBe(2)
  expect(clampZoom(1.1000000000000003)).toBe(1.1)
})

test('reconnaît Ctrl + / − / 0 et ignore le reste', () => {
  const key = (k: string, mods: Partial<KeyboardEvent> = { ctrlKey: true }) =>
    readingZoomShortcut({ ctrlKey: false, metaKey: false, altKey: false, key: k, ...mods })
  expect(key('=')).toBe(1)
  expect(key('+')).toBe(1)
  expect(key('-')).toBe(-1)
  expect(key('0')).toBe(0)
  expect(key('0', { metaKey: true })).toBe(0)
  expect(key('=', {})).toBeNull()
  expect(key('-', { ctrlKey: true, altKey: true })).toBeNull()
  expect(key('f')).toBeNull()
})
