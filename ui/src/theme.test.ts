import { expect, test } from 'bun:test'
import { resolveTheme } from './theme'

test('le thème Système suit la préférence claire ou sombre du système', () => {
  expect(resolveTheme('system', true)).toBe('light')
  expect(resolveTheme('system', false)).toBe('dark')
  expect(resolveTheme('night', true)).toBe('night')
  expect(resolveTheme('light', false)).toBe('light')
})
