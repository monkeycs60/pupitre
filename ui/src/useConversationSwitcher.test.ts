import { afterEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { SWITCHER_REVEAL_MS, useConversationSwitcher } from './useConversationSwitcher'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { act, cleanup, renderHook } = await import('@testing-library/react')

afterEach(() => {
  cleanup()
})

const items = ['a', 'b', 'c']

function setup(list: string[] = items) {
  const committed: string[] = []
  const hook = renderHook(() => useConversationSwitcher(list, (item) => committed.push(item)))
  return { committed, hook }
}

function press(key: string, init: KeyboardEventInit = {}) {
  act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true, ...init })) })
}

function releaseCtrl() {
  act(() => { window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', bubbles: true })) })
}

test('un appui bref sur Ctrl Tab rappelle la première conversation sans afficher le sélecteur', () => {
  const { committed, hook } = setup()

  press('Tab')
  expect(hook.result.current.state).toEqual({ index: 0, visible: false })
  releaseCtrl()

  expect(committed).toEqual(['a'])
  expect(hook.result.current.state).toBeNull()
})

test('Ctrl maintenu, chaque Tab avance en bouclant, Maj Tab recule, et relâcher Ctrl ouvre la sélection', () => {
  const { committed, hook } = setup()

  press('Tab')
  press('Tab')
  expect(hook.result.current.state).toEqual({ index: 1, visible: true })
  press('Tab')
  press('Tab')
  expect(hook.result.current.state?.index).toBe(0)
  press('Tab', { shiftKey: true })
  expect(hook.result.current.state?.index).toBe(2)
  releaseCtrl()

  expect(committed).toEqual(['c'])
})

test('Ctrl Maj Tab démarre sur la dernière conversation, sélecteur affiché', () => {
  const { hook } = setup()
  press('Tab', { shiftKey: true })
  expect(hook.result.current.state).toEqual({ index: 2, visible: true })
})

test('le sélecteur apparaît si Ctrl reste enfoncé après le premier Tab', async () => {
  const { hook } = setup()
  press('Tab')
  await act(() => new Promise((resolve) => setTimeout(resolve, SWITCHER_REVEAL_MS + 50)))
  expect(hook.result.current.state).toEqual({ index: 0, visible: true })
})

test('Échap et la perte du focus annulent ; Entrée valide sans atteindre la page', () => {
  const { committed, hook } = setup()
  const reachedPage: string[] = []
  const listener = (event: KeyboardEvent) => reachedPage.push(event.key)
  document.addEventListener('keydown', listener)

  press('Tab')
  press('Tab')
  press('Escape')
  expect(hook.result.current.state).toBeNull()
  releaseCtrl()

  press('Tab')
  act(() => { window.dispatchEvent(new Event('blur')) })
  expect(hook.result.current.state).toBeNull()

  press('Tab')
  press('Tab')
  press('Enter')
  document.removeEventListener('keydown', listener)

  expect(committed).toEqual(['b'])
  expect(reachedPage).toEqual([])
})

test('sans conversation à rappeler, Ctrl Tab ne fait rien', () => {
  const { committed, hook } = setup([])
  press('Tab')
  releaseCtrl()
  expect(hook.result.current.state).toBeNull()
  expect(committed).toEqual([])
})
