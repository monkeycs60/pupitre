import { expect, test } from 'bun:test'
import { buildTodoInput } from './todoDraft'

test('la TODO conserve sa configuration sans envoyer les champs propres aux conversations', () => {
  const file = { name: 'stored.pdf', originalName: 'brief.pdf', mimeType: 'application/pdf', size: 10 }
  const input = buildTodoInput({ provider: 'codex', model: 'gpt-5.6-sol', effort: 'high', speed: 'fast', permissionMode: null, branch: ' TECH-24128 ', ticketKey: 'TECH-24128' }, { message: 'Corriger le formulaire', ticketId: 'ticket-1', autonomy: 'local', integrate: true, checks: 'bun test\n\n bun run build ', attachments: [file] })
  expect(input.targetBranch).toBe('TECH-24128')
  expect(input.ticketId).toBe('ticket-1')
  expect(input.checks).toEqual(['bun test', 'bun run build'])
  expect(input.attachments).toEqual([file])
  expect(input.speed).toBe('fast')
  expect(input).not.toHaveProperty('branch')
  expect(input).not.toHaveProperty('ticketKey')
  expect(input).not.toHaveProperty('projectId')
})
test('une enquête ne peut pas autoriser intégration et push', () => {
  const input = buildTodoInput({ provider: 'claude', model: 'opus', effort: 'high', speed: 'standard', permissionMode: null }, { message: 'Enquêter', ticketId: null, autonomy: 'investigate', integrate: true, checks: '', attachments: [] })
  expect(input.integrate).toBe(false)
  expect(input.targetBranch).toBeNull()
  expect(input.images).toEqual([])
})
