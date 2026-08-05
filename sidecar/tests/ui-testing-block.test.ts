import { expect, test } from 'bun:test'
import { groupEvents } from '../../ui/src/groupEvents'
import type { AppEvent } from '../../ui/src/types'

test('l inventaire reste une carte unique dont le scope reçoit son résultat', () => {
  const events: AppEvent[] = [{
    type: 'test-inventory-ref',
    inventoryId: 'inventory',
    createdAt: '2026-08-04T12:00:00Z',
    scopes: [{
      id: 'scope',
      title: 'API',
      description: 'Contrat',
      methods: [{ kind: 'unit', label: 'bun test', instructions: 'bun test' }],
      guardianFlagIds: ['flag'],
      status: 'pending',
      subtaskId: null,
      evidenceMd: null,
      error: null,
    }],
  }, {
    type: 'test-scope-started',
    inventoryId: 'inventory',
    scopeId: 'scope',
    subtaskId: 'subtask',
    startedAt: '2026-08-04T12:01:00Z',
  }, {
    type: 'test-scope-result',
    inventoryId: 'inventory',
    scopeId: 'scope',
    status: 'passed',
    evidenceMd: '12 tests passent',
    guardianFlagIdsAcked: ['flag'],
    completedAt: '2026-08-04T12:02:00Z',
  }]

  expect(groupEvents(events)).toEqual([
    expect.objectContaining({
      kind: 'test-inventory',
      scopes: [expect.objectContaining({
        id: 'scope',
        status: 'passed',
        subtaskId: 'subtask',
        evidenceMd: '12 tests passent',
      })],
    }),
  ])
})
