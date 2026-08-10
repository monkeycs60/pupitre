import { expect, test } from 'bun:test'
import { countConversationMessages } from './conversationMessageCount'

test('compte une seule réponse assistant par tour dans le flux live', () => {
  expect(countConversationMessages([
    { type: 'user-message' },
    { type: 'text-final' },
    { type: 'tool-start' },
    { type: 'text-final' },
    { type: 'user-message' },
    { type: 'text-final' },
  ])).toBe(4)
})

test('ne compte pas les événements techniques', () => {
  expect(countConversationMessages([
    { type: 'status' },
    { type: 'usage' },
    { type: 'tool-start' },
  ])).toBe(0)
})
