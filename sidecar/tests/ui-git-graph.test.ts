import { expect, test } from 'bun:test'
import { layoutGitGraph } from '../../ui/src/gitGraph'
import type { GitCommit } from '../../ui/src/types'

function commit(sha: string, parents: string[]): GitCommit {
  return {
    sha,
    parents,
    refs: [],
    author: 'Test',
    authoredAt: '2026-08-04T12:00:00Z',
    subject: sha,
    conversations: [],
    guardian: null,
  }
}

test('dessine une ligne droite pour un historique linéaire', () => {
  const rows = layoutGitGraph([
    commit('c', ['b']),
    commit('b', ['a']),
    commit('a', []),
  ])

  expect(rows.map((row) => row.lane)).toEqual([0, 0, 0])
  expect(rows[0]?.segments).toContainEqual({ from: 0, to: 0, kind: 'parent' })
})

test('ouvre deux voies et une diagonale pour un commit de merge', () => {
  const rows = layoutGitGraph([
    commit('merge', ['left', 'right']),
    commit('left', ['base']),
    commit('right', ['base']),
    commit('base', []),
  ])

  expect(rows[0]?.laneCount).toBe(2)
  expect(rows[0]?.segments).toEqual(expect.arrayContaining([
    { from: 0, to: 0, kind: 'parent' },
    { from: 0, to: 1, kind: 'parent' },
  ]))
  expect(rows[2]?.lane).toBe(1)
})
