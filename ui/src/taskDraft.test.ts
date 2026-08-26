import { describe, expect, test } from 'bun:test'
import { toggleAction } from './taskDraft'
import type { TaskAction } from './taskToggle'

function action(scope: string, label: string): TaskAction {
  return { scope, label, index: 1, kind: 'follow-up' }
}

describe('toggleAction', () => {
  test('distingue deux actions de même rang provenant de messages différents', () => {
    const first = action('message-1', 'Première piste')
    const second = action('message-2', 'Deuxième piste')

    expect(toggleAction([first], second, true)).toEqual([first, second])
    expect(toggleAction([first, second], second, false)).toEqual([first])
  })
})
