import { expect, test } from 'bun:test'
import { buildTodoInput } from './todoDraft'

test('la tâche conserve sa configuration sans envoyer les champs propres aux conversations', () => {
  const file = { name: 'stored.pdf', originalName: 'brief.pdf', mimeType: 'application/pdf', size: 10 }
  const image = { name: 'shot.png', originalName: 'shot.png', mimeType: 'image/png', size: 10 }
  const input = buildTodoInput({ provider: 'codex', model: 'gpt-5.6-sol', effort: 'high', speed: 'fast', permissionMode: null, branch: ' TECH-24128 ', ticketKey: 'TECH-24128' }, { message: 'Corriger le formulaire', ticketId: 'ticket-1', finish: 'commit_push', attachments: [file, image] })
  expect(input.targetBranch).toBe('TECH-24128')
  expect(input.ticketId).toBe('ticket-1')
  expect(input.finish).toBe('commit_push')
  expect(input.attachments).toEqual([file, image])
  expect(input.images).toEqual(['shot.png'])
  expect(input.speed).toBe('fast')
  expect(input).not.toHaveProperty('branch')
  expect(input).not.toHaveProperty('ticketKey')
  expect(input).not.toHaveProperty('projectId')
})
test('la vitesse ne part que vers Codex et la branche vide reste nulle', () => {
  const input = buildTodoInput({ provider: 'claude', model: 'opus', effort: 'high', speed: 'fast', permissionMode: null }, { message: 'Enquêter', ticketId: null, finish: 'none', attachments: [] })
  expect(input.speed).toBeUndefined()
  expect(input.targetBranch).toBeNull()
  expect(input.images).toEqual([])
})
