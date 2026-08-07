import { expect, test } from 'bun:test'
import { gitRefOptions, layoutGitGraph, updateGitCompareRef } from '../../ui/src/gitGraph'
import type { GitCommit, GitSnapshot } from '../../ui/src/types'

function commit(sha: string, parents: string[]): GitCommit {
  return {
    sha,
    parents,
    refs: [],
    author: 'Test',
    authoredAt: '2026-08-04T12:00:00Z',
    subject: sha,
    conversations: [],
    guardian: [],
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

test('expose le parent de HEAD même hors de la fenêtre des commits', () => {
  const head = commit('head-sha', ['parent-outside-window'])
  const snapshot: GitSnapshot = {
    head: head.sha,
    headParents: head.parents,
    currentBranch: 'main',
    commits: [head],
    branches: [{ name: 'main', fullName: 'refs/heads/main', sha: head.sha, current: true, remote: false }],
    worktrees: [],
  }

  expect(gitRefOptions(snapshot)).toContainEqual([
    'parent-outside-window',
    'parent-o · Parent de HEAD',
  ])
})

test('alimente la base ou la cible depuis un commit sans écraser l’autre référence', () => {
  const refs = { baseRef: 'base', headRef: 'head' }

  expect(updateGitCompareRef(refs, 'base', 'commit-a')).toEqual({
    baseRef: 'commit-a',
    headRef: 'head',
  })
  expect(updateGitCompareRef(refs, 'head', 'commit-b')).toEqual({
    baseRef: 'base',
    headRef: 'commit-b',
  })
})
