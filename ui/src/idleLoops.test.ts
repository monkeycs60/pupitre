import { expect, test } from 'bun:test'
import { pauseLoopsWhileUnfocused } from './idleLoops'

function fakeAnimation(iterations: number) {
  const animation = {
    playState: 'running' as AnimationPlayState,
    effect: { getTiming: () => ({ iterations }) },
    pause() { animation.playState = 'paused' },
    play() { animation.playState = 'running' },
  }
  return animation
}

function fakeWindow(animations: ReturnType<typeof fakeAnimation>[]) {
  const listeners = new Map<string, () => void>()
  const doc = {
    focused: true,
    visibilityState: 'visible',
    hasFocus: () => doc.focused,
    getAnimations: () => animations,
    addEventListener: (type: string, listener: () => void) => listeners.set(`doc:${type}`, listener),
    removeEventListener: () => {},
  }
  const win = {
    document: doc,
    setTimeout: (callback: () => void) => callback(),
    addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
    removeEventListener: () => {},
  } as unknown as Window
  return { win, doc, fire: (type: string) => listeners.get(type)!() }
}

test('fige les boucles sans focus et les relance au retour, sans toucher aux animations finies', () => {
  const loop = fakeAnimation(Infinity)
  const entrance = fakeAnimation(1)
  const { win, doc, fire } = fakeWindow([loop, entrance])
  pauseLoopsWhileUnfocused(win)
  expect(loop.playState).toBe('running')

  doc.focused = false
  fire('blur')
  expect(loop.playState).toBe('paused')
  expect(entrance.playState).toBe('running')

  doc.focused = true
  fire('focus')
  expect(loop.playState).toBe('running')
})

test('garde les boucles actives quand le focus passe dans une iframe de la page', () => {
  const loop = fakeAnimation(Infinity)
  const { win, fire } = fakeWindow([loop])
  pauseLoopsWhileUnfocused(win)
  fire('blur')
  expect(loop.playState).toBe('running')
})
