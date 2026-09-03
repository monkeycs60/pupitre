import { expect, test } from 'bun:test'
import { navigationEventFromMessage } from './visualFeedbackNavigation'

test('accepte uniquement une destination de conversation complète', () => {
  expect(navigationEventFromMessage('{"type":"open-conversation","projectId":"p1","conversationId":"c1"}'))
    .toEqual({ projectId: 'p1', conversationId: 'c1' })
  expect(navigationEventFromMessage('{"type":"open-conversation","conversationId":"c1"}')).toBeNull()
  expect(navigationEventFromMessage('non-json')).toBeNull()
})
