import { expect, test } from 'bun:test'
import { pillClearance } from './jarvis.ts'

const box = (left: number, top: number, right: number) => ({ left, top, right })

test('la pastille reste dans le coin quand le composer ne passe pas sous elle', () => {
  expect(pillClearance([box(500, 768, 1500)], box(1773, 844, 1900), 900)).toBeNull()
  expect(pillClearance([], box(1133, 844, 1260), 900)).toBeNull()
})

test('la pastille passe au-dessus du composer et de la jauge qui dépasse de son bord', () => {
  expect(pillClearance([box(396, 768, 1236), box(1105, 746, 1207)], box(1133, 732, 1260), 900)).toBe(166)
  expect(pillClearance([box(396, 640, 1236), box(1105, 618, 1207)], box(1133, 732, 1260), 900)).toBe(294)
})
