import { expect, test } from 'bun:test'
import { withFleetOutcome, type FleetHistoryItem } from './useFleet'

const entry = (id: string): FleetHistoryItem => ({
  id,
  kind: 'turn',
  projectId: 'p',
  projectName: 'pupitre',
  conversationId: `c-${id}`,
  title: 'Zoom',
  provider: 'claude',
  model: 'opus',
  startedAt: '2026-10-06T08:00:00.000Z',
  lastEvent: 'outil terminé',
  leftActiveAt: '2026-10-06T08:05:00.000Z',
})

test('pose l’issue et le message d’erreur sur le seul run concerné', () => {
  const history = withFleetOutcome([entry('a'), entry('b')], 'b', 'error', 'exit 143')
  expect(history[0]).toEqual(entry('a'))
  expect(history[1]).toMatchObject({ id: 'b', outcome: 'error', outcomeError: 'exit 143' })
  expect(withFleetOutcome([entry('a')], 'a', 'done', null)[0]).not.toHaveProperty('outcomeError')
})
