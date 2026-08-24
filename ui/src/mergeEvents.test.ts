import { expect, test } from 'bun:test'
import { appendLiveEvent, mergeReplayAndBuffer } from './mergeEvents'
import type { StoredEvent } from './types'

function event(id: number): StoredEvent {
  return { id, type: 'text-delta', text: `t${id}` } as StoredEvent
}

test('un événement plus récent que le fil est appendé tel quel', () => {
  const current = [event(1), event(2)]
  const next = appendLiveEvent(current, event(3))
  expect(next.map((item) => item.id)).toEqual([1, 2, 3])
  expect(next).not.toBe(current)
})

test('le premier événement d’un fil vide est appendé', () => {
  expect(appendLiveEvent([], event(7)).map((item) => item.id)).toEqual([7])
})

// Le fil courant est autoritaire jusqu'à son plus grand id (cf. commentaire de
// mergeReplayAndBuffer) : un doublon ou un retard est écarté, comme avant le
// fast-path.
test('un doublon ou un retard ne doublonne ni ne réordonne', () => {
  const current = [event(1), event(3)]
  expect(appendLiveEvent(current, event(3)).map((item) => item.id)).toEqual([1, 3])
  expect(appendLiveEvent(current, event(2)).map((item) => item.id)).toEqual([1, 3])
})

test('la fusion replay/buffer reste idempotente et triée', () => {
  const merged = mergeReplayAndBuffer([event(1), event(2)], [event(2), event(4), event(3)])
  expect(merged.map((item) => item.id)).toEqual([1, 2, 3, 4])
})
