import { expect, test } from 'bun:test'
import { composerClearance } from './composerClearance.ts'

const box = (left: number, top: number, right: number) => ({ left, top, right })

test('la zone reste dans le coin quand le composer ne passe pas sous elle', () => {
  expect(composerClearance([box(500, 768, 1500)], 1773, 900)).toBeNull()
  expect(composerClearance([], 1133, 900)).toBeNull()
})

test('la zone passe au-dessus du composer et de la jauge qui dépasse de son bord', () => {
  expect(composerClearance([box(396, 768, 1236), box(1105, 746, 1207)], 1133, 900)).toBe(166)
  expect(composerClearance([box(396, 640, 1236), box(1105, 618, 1207)], 1133, 900)).toBe(294)
})
