import { expect, test } from 'bun:test'
import { renderHook } from '@testing-library/react'
import { groupEvents } from './groupEvents'
import { useGroupedEvents } from './useGroupedEvents'
import type { StoredEvent } from './types'

test('fige les anciens tours sans changer les blocs produits', () => {
  const first: StoredEvent[] = [
    { id: 1, type: 'user-message', text: 'un', images: [] },
    { id: 2, type: 'text-final', text: 'réponse un' },
    { id: 3, type: 'usage', inputTokens: 10, outputTokens: 2 },
    { id: 4, type: 'status', state: 'done' },
    { id: 5, type: 'user-message', text: 'deux', images: [] },
    { id: 6, type: 'text-delta', text: 'réponse' },
  ]
  const { result, rerender } = renderHook(
    ({ events }) => useGroupedEvents('conversation-test', events),
    { initialProps: { events: first } },
  )
  expect(result.current).toEqual(groupEvents(first))

  const next = [...first, { id: 7, type: 'text-delta', text: ' deux' } as StoredEvent]
  rerender({ events: next })
  expect(result.current).toEqual(groupEvents(next))
})

test('une notification de tâche de fond coupe le message en cours', () => {
  const blocks = groupEvents([
    { id: 1, type: 'user-message', text: 'continue', images: [] },
    { id: 2, type: 'background-task', status: 'stopped', summary: 'Background shell command didn\'t finish' },
    { id: 3, type: 'text-final', text: 'Je reprends.' },
  ] as StoredEvent[])

  expect(blocks.map((block) => block.kind)).toEqual(['user', 'background-task', 'assistant'])
})

test('fusionne les notifications de tâches de fond consécutives', () => {
  const blocks = groupEvents([
    { id: 1, type: 'user-message', text: 'continue', images: [] },
    { id: 2, type: 'background-task', status: 'stopped', summary: 'a' },
    { id: 3, type: 'background-task', status: 'stopped', summary: 'b' },
    { id: 4, type: 'text-final', text: 'Je reprends.' },
    { id: 5, type: 'background-task', status: 'completed', summary: 'c' },
  ] as StoredEvent[])

  expect(blocks.filter((block) => block.kind === 'background-task').map((block) =>
    block.kind === 'background-task' ? block.tasks.map((task) => task.summary) : [])).toEqual([['a', 'b'], ['c']])
})

test('un tour ouvert par l’agent garde son propre pied de tour', () => {
  const blocks = groupEvents([
    { id: 1, type: 'user-message', text: 'lance la recette', images: [] },
    { id: 2, type: 'turn-timing', phase: 'started', startedAt: '2026-09-23T10:00:00.000Z' },
    { id: 3, type: 'text-final', text: 'Lancée.' },
    { id: 4, type: 'status', state: 'done' },
    { id: 5, type: 'turn-timing', phase: 'started', startedAt: '2026-09-23T10:05:00.000Z' },
    { id: 6, type: 'status', state: 'running' },
    { id: 7, type: 'background-task', status: 'completed', summary: 'recette' },
    { id: 8, type: 'text-final', text: 'Recette finie.' },
    { id: 9, type: 'status', state: 'done' },
  ] as StoredEvent[])

  expect(blocks.map((block) => block.kind)).toEqual([
    'user', 'assistant', 'turn-footer', 'background-task', 'assistant', 'turn-footer',
  ])
  const footers = blocks.filter((block) => block.kind === 'turn-footer')
  expect(new Set(footers.map((footer) => footer.id)).size).toBe(2)
  expect(footers.map((footer) => footer.kind === 'turn-footer' ? footer.timing?.startedAt : null)).toEqual([
    '2026-09-23T10:00:00.000Z', '2026-09-23T10:05:00.000Z',
  ])
})

test('le pied d’un tour ouvert par l’agent en indique l’origine', () => {
  const footers = (events: StoredEvent[]) => groupEvents(events)
    .filter((block) => block.kind === 'turn-footer')
    .map((block) => block.kind === 'turn-footer' ? block.origin : null)
  const base = [
    { id: 1, type: 'user-message', text: 'lance', images: [] },
    { id: 2, type: 'turn-timing', phase: 'started', startedAt: '2026-09-23T10:00:00.000Z' },
    { id: 3, type: 'status', state: 'done' },
    { id: 4, type: 'turn-timing', phase: 'started', startedAt: '2026-09-23T10:05:00.000Z' },
    { id: 5, type: 'status', state: 'running' },
  ] as StoredEvent[]

  expect(footers([...base, { id: 6, type: 'text-final', text: 'Rappel.' }, { id: 7, type: 'status', state: 'done' }] as StoredEvent[]))
    .toEqual([undefined, 'agent'])
  expect(footers([...base, { id: 6, type: 'background-task', status: 'completed', summary: 'a' }, { id: 7, type: 'status', state: 'done' }] as StoredEvent[]))
    .toEqual([undefined, 'background-task'])
  expect(footers([
    { id: 1, type: 'user-message', text: 'continue', images: [] },
    { id: 2, type: 'turn-timing', phase: 'started', startedAt: '2026-09-23T10:00:00.000Z' },
    { id: 3, type: 'background-task', status: 'stopped', summary: 'orpheline' },
    { id: 4, type: 'status', state: 'done' },
  ] as StoredEvent[])).toEqual([undefined])
})
