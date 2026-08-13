import { describe, expect, test } from 'bun:test'
import { isAppRestartShortcut } from './appRestart'

function key(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    altKey: false,
    ctrlKey: false,
    key: 'r',
    metaKey: false,
    shiftKey: false,
    ...overrides,
  } as KeyboardEvent
}

describe('raccourci de redémarrage', () => {
  test('accepte Ctrl/Cmd + Maj + R', () => {
    expect(isAppRestartShortcut(key({ ctrlKey: true, shiftKey: true }))).toBe(true)
    expect(isAppRestartShortcut(key({ metaKey: true, shiftKey: true, key: 'R' }))).toBe(true)
  })

  test('laisse Ctrl+R et Alt+Ctrl+Maj+R au moteur de la webview', () => {
    expect(isAppRestartShortcut(key({ ctrlKey: true }))).toBe(false)
    expect(isAppRestartShortcut(key({ altKey: true, ctrlKey: true, shiftKey: true }))).toBe(false)
  })
})
