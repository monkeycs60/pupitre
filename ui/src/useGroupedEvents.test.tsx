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
