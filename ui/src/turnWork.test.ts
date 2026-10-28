import { expect, test } from 'bun:test'
import type { StreamBlock } from './groupEvents'
import { foldTurns, turnWorkNoteCount, turnWorkTools, type TurnWorkBlock } from './turnWork'

const user = (id: string): StreamBlock => ({ kind: 'user', id, text: id, images: [], attachments: [] })
const say = (id: string): StreamBlock => ({ kind: 'assistant', id, text: id, streaming: false })
const tool = (id: string): StreamBlock => ({ kind: 'tool', id, toolId: id, toolName: 'Bash', input: { command: 'ls' }, output: 'ok', images: [] })
const footer = (id: string, state: 'running' | 'done' | 'error'): StreamBlock => ({ kind: 'turn-footer', id, status: { type: 'status', state } })

function ids(items: Array<StreamBlock | TurnWorkBlock>): string[] {
  return items.map((item) => item.kind === 'turn-work' ? `[${item.blocks.map((block) => block.id).join(',')}]` : item.id)
}

test('un tour terminé ne garde visibles que la question et la réponse finale', () => {
  const folded = foldTurns([
    user('q'), say('je regarde'), tool('t1'), say('je corrige'), tool('t2'), say('fini'), say('suite'), footer('f', 'done'),
  ])

  expect(ids(folded)).toEqual(['q', '[je regarde,t1,je corrige,t2]', 'fini', 'suite', 'f'])
  const work = folded[1] as TurnWorkBlock
  expect(turnWorkTools(work)).toHaveLength(2)
  expect(turnWorkNoteCount(work)).toBe(2)
})

test('le tour en cours se replie sur une ligne vivante, le texte qui suit la dernière activité reste lisible', () => {
  const blocks = [user('q'), say('je regarde'), tool('t1'), say('réponse partielle'), footer('f', 'running')]
  const folded = foldTurns(blocks)

  expect(ids(folded)).toEqual(['q', '[je regarde,t1]', 'réponse partielle', 'f'])
  expect((folded[1] as TurnWorkBlock).live).toBeDefined()
})

test('le tour qui démarre a déjà sa ligne vivante, vide, sous la question', () => {
  const folded = foldTurns([user('q'), footer('f', 'running')])

  expect(ids(folded)).toEqual(['q', '[]', 'f'])
  expect((folded[1] as TurnWorkBlock).live).toBeDefined()
})

test('la ligne garde sa clé quand le tour passe de en cours à terminé', () => {
  const timing = { startedAt: '2026-10-07T10:00:00.000Z', completedAt: '2026-10-07T10:00:04.000Z' }
  const running = foldTurns([user('q'), tool('t1'), footer('f', 'running')])
  const done = foldTurns([user('q'), tool('t1'), say('r'), { ...footer('f', 'done'), timing } as StreamBlock])

  expect(running[1].id).toBe(done[1].id)
  expect((done[1] as TurnWorkBlock).live).toBeUndefined()
})

test('un tour terminé sans outil garde une ligne vide quand sa durée est connue', () => {
  const timing = { startedAt: '2026-10-07T10:00:00.000Z', completedAt: '2026-10-07T10:00:04.000Z' }
  const folded = foldTurns([user('q'), say('r'), { ...footer('f', 'done'), timing } as StreamBlock])

  expect(ids(folded)).toEqual(['q', '[]', 'r', 'f'])
  expect((folded[1] as TurnWorkBlock).durationMs).toBe(4000)
})

test('un tour sans réponse après son dernier outil reste déplié', () => {
  const blocks = [user('q'), say('je lance'), tool('t1'), footer('f', 'error')]

  expect(ids(foldTurns(blocks))).toEqual(['q', 'je lance', 't1', 'f'])
})

test('les messages de pilotage et les livrables sortent du repli', () => {
  const steering: StreamBlock = { kind: 'user', id: 'pilotage', text: 'plutôt ça', images: [], attachments: [], steering: true }
  const document: StreamBlock = { kind: 'html-document', id: 'doc', documentId: 'd', title: 'Audit', sizeBytes: 1, createdAt: '', expiresAt: null }
  const folded = foldTurns([
    user('q'), tool('t1'), steering, tool('t2'), document, say('voici'), footer('f', 'done'),
  ])

  expect(ids(folded)).toEqual(['q', '[t1,t2]', 'pilotage', 'doc', 'voici', 'f'])
})

test('chaque tour terminé est replié indépendamment', () => {
  const folded = foldTurns([
    user('q1'), tool('a'), say('r1'), footer('f1', 'done'),
    user('q2'), say('r2'), footer('f2', 'done'),
    user('q3'), tool('b'), footer('f3', 'running'),
  ])

  expect(ids(folded)).toEqual(['q1', '[a]', 'r1', 'f1', 'q2', 'r2', 'f2', 'q3', '[b]', 'f3'])
})

test('la ligne repliée porte la durée du tour', () => {
  const done: StreamBlock = {
    kind: 'turn-footer',
    id: 'f',
    status: { type: 'status', state: 'done' },
    timing: { startedAt: '2026-10-07T10:00:00.000Z', completedAt: '2026-10-07T10:07:30.000Z' },
  }
  const [, work] = foldTurns([user('q'), tool('t1'), say('r'), done]) as [StreamBlock, TurnWorkBlock]

  expect(work.durationMs).toBe(450_000)
  expect(foldTurns([user('q'), tool('t1'), say('r'), footer('g', 'done')])
    .some((item) => item.kind === 'turn-work' && item.durationMs !== undefined)).toBe(false)
})
