import { expect, test } from 'bun:test'
import type { StreamBlock } from './groupEvents'
import { foldFinishedTurns, turnWorkNoteCount, turnWorkTools, type TurnWorkBlock } from './turnWork'

const user = (id: string): StreamBlock => ({ kind: 'user', id, text: id, images: [], attachments: [] })
const say = (id: string): StreamBlock => ({ kind: 'assistant', id, text: id, streaming: false })
const tool = (id: string): StreamBlock => ({ kind: 'tool', id, toolId: id, toolName: 'Bash', input: { command: 'ls' }, output: 'ok', images: [] })
const footer = (id: string, state: 'running' | 'done' | 'error'): StreamBlock => ({ kind: 'turn-footer', id, status: { type: 'status', state } })

function ids(items: Array<StreamBlock | TurnWorkBlock>): string[] {
  return items.map((item) => item.kind === 'turn-work' ? `[${item.blocks.map((block) => block.id).join(',')}]` : item.id)
}

test('un tour terminé ne garde visibles que la question et la réponse finale', () => {
  const folded = foldFinishedTurns([
    user('q'), say('je regarde'), tool('t1'), say('je corrige'), tool('t2'), say('fini'), say('suite'), footer('f', 'done'),
  ])

  expect(ids(folded)).toEqual(['q', '[je regarde,t1,je corrige,t2]', 'fini', 'suite', 'f'])
  const work = folded[1] as TurnWorkBlock
  expect(turnWorkTools(work)).toHaveLength(2)
  expect(turnWorkNoteCount(work)).toBe(2)
})

test('le tour en cours reste entièrement déplié', () => {
  const blocks = [user('q'), tool('t1'), say('réponse partielle'), footer('f', 'running')]

  expect(ids(foldFinishedTurns(blocks))).toEqual(['q', 't1', 'réponse partielle', 'f'])
})

test('un tour sans réponse après son dernier outil reste déplié', () => {
  const blocks = [user('q'), say('je lance'), tool('t1'), footer('f', 'error')]

  expect(ids(foldFinishedTurns(blocks))).toEqual(['q', 'je lance', 't1', 'f'])
})

test('les messages de pilotage et les livrables sortent du repli', () => {
  const steering: StreamBlock = { kind: 'user', id: 'pilotage', text: 'plutôt ça', images: [], attachments: [], steering: true }
  const document: StreamBlock = { kind: 'html-document', id: 'doc', documentId: 'd', title: 'Audit', sizeBytes: 1, createdAt: '', expiresAt: null }
  const folded = foldFinishedTurns([
    user('q'), tool('t1'), steering, tool('t2'), document, say('voici'), footer('f', 'done'),
  ])

  expect(ids(folded)).toEqual(['q', '[t1,t2]', 'pilotage', 'doc', 'voici', 'f'])
})

test('chaque tour terminé est replié indépendamment', () => {
  const folded = foldFinishedTurns([
    user('q1'), tool('a'), say('r1'), footer('f1', 'done'),
    user('q2'), say('r2'), footer('f2', 'done'),
    user('q3'), tool('b'), footer('f3', 'running'),
  ])

  expect(ids(folded)).toEqual(['q1', '[a]', 'r1', 'f1', 'q2', 'r2', 'f2', 'q3', 'b', 'f3'])
})
