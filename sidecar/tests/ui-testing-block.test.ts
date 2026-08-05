import { expect, test } from 'bun:test'
import { groupEvents } from '../../ui/src/groupEvents'
import type { AppEvent } from '../../ui/src/types'

test('l inventaire forme une carte unique avec ses scopes structurés', () => {
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
  }]

  expect(groupEvents(events)).toEqual([
    expect.objectContaining({
      kind: 'test-inventory',
      scopes: [expect.objectContaining({
        id: 'scope',
        status: 'pending',
        subtaskId: null,
        evidenceMd: null,
      })],
    }),
  ])
})
