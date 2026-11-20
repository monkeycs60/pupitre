import { expect, test } from 'bun:test'
import { mergeRecentConversations } from './recentConversations'
import type { ViewedConversation } from './types'

function viewed(id: string, viewedAt: string, overrides: Partial<ViewedConversation> = {}): ViewedConversation {
  return {
    id, project_id: 'p1', project_name: 'pupitre', title: `Titre ${id}`, summary: '', provider: 'claude', model: 'opus',
    answered_turn: 1, last_read_turn: 1, updated_at: viewedAt, viewed_at: viewedAt, ...overrides,
  }
}

const stored = [
  viewed('a', '2026-11-20T10:09:00.000Z'),
  viewed('b', '2026-11-20T10:05:00.000Z'),
  viewed('c', '2026-11-20T10:01:00.000Z'),
]

test('la conversation quittée passe en tête même si le sidecar ne l’a pas encore comptée comme lue', () => {
  const skimmed = viewed('z', '2026-11-20T10:10:00.000Z', { title: 'Survolée' })
  expect(mergeRecentConversations(stored, skimmed, 'a').map((item) => item.id)).toEqual(['z', 'b', 'c'])
})

test('une conversation déjà connue du sidecar remonte en tête sans doublon, avec son titre à jour', () => {
  const pinned = viewed('c', '2026-11-20T10:11:00.000Z', { title: 'Ancien titre' })
  const merged = mergeRecentConversations(stored, pinned, 'a')
  expect(merged.map((item) => [item.id, item.title, item.viewed_at])).toEqual([
    ['c', 'Titre c', '2026-11-20T10:11:00.000Z'],
    ['b', 'Titre b', '2026-11-20T10:05:00.000Z'],
  ])
})

test('la conversation affichée est exclue, y compris quand elle est épinglée, et la liste plafonne', () => {
  expect(mergeRecentConversations(stored, viewed('a', '2026-11-20T10:12:00.000Z'), 'a').map((item) => item.id)).toEqual(['b', 'c'])
  expect(mergeRecentConversations(stored, null, null, 2).map((item) => item.id)).toEqual(['a', 'b'])
})
