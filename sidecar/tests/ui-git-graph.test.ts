import { expect, test } from 'bun:test'
import { defaultGitCompareRefs, gitGraphCellGeometry, gitGraphRowLabel, gitRefOptions, layoutGitGraph, updateGitCompareRef } from '../../ui/src/gitGraph'
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

test('compare par défaut la base distante au HEAD du worktree', () => {
  const snapshot: GitSnapshot = {
    head: 'feature-head',
    headParents: ['feature-parent'],
    currentBranch: 'testcs',
    commits: [commit('feature-head', ['feature-parent'])],
    branches: [
      { name: 'origin/master', fullName: 'refs/remotes/origin/master', sha: 'remote-base', current: false, remote: true },
      { name: 'testcs', fullName: 'refs/heads/testcs', sha: 'feature-head', current: true, remote: false },
    ],
    worktrees: [],
  }

  expect(defaultGitCompareRefs(snapshot)).toEqual({
    baseRef: 'remote-base',
    headRef: 'feature-head',
  })
})

test('place le point du commit au centre de sa lane', () => {
  const [row] = layoutGitGraph([commit('a', ['b']), commit('b', [])])
  const geometry = gitGraphCellGeometry(row!)

  expect(geometry.dot).toEqual({ x: 7, y: 50 })
  expect(geometry.width).toBe(14)
})

test('trace un chemin vers chaque parent d’un merge', () => {
  const rows = layoutGitGraph([
    commit('m', ['a', 'b']),
    commit('a', []),
    commit('b', []),
  ])
  const geometry = gitGraphCellGeometry(rows[0]!)

  expect(geometry.paths.filter((path) => path.kind === 'parent')).toHaveLength(2)
  for (const path of geometry.paths) expect(path.d.startsWith('M ')).toBe(true)
})

test('le layout du graphe conserve un repère étirable indépendant de la ligne', () => {
  // Mesuré dans l'app : une ligne de commit fait de 58 à 98 px selon son
  // contenu. Le repère doit donc être constant et indépendant du CSS.
  const heights = [
    layoutGitGraph([commit('a', [])]),
    layoutGitGraph([commit('m', ['a', 'b']), commit('a', []), commit('b', [])]),
  ].map((rows) => gitGraphCellGeometry(rows[0]!).viewBoxHeight)

  expect(new Set(heights).size).toBe(1)
})

/** Points où un tracé sort en bas (y = viewBoxHeight) / entre en haut (y = 0). */
function edges(geometry: ReturnType<typeof gitGraphCellGeometry>) {
  const exits = new Set<number>()
  const entries = new Set<number>()
  for (const path of geometry.paths) {
    const nums = path.d.match(/-?[\d.]+/g)!.map(Number)
    if (nums[1] === 0) entries.add(nums[0]!)
    if (nums[nums.length - 1] === geometry.viewBoxHeight) exits.add(nums[nums.length - 2]!)
  }
  return { exits: [...exits].sort(), entries: [...entries].sort() }
}

test('le tracé est continu d’une ligne à la suivante', () => {
  // Le défaut trouvé dans l'app : chaque ligne descendait de son point vers le
  // bas, mais rien ne descendait du haut jusqu'au point — 185 ruptures sur 186.
  const rows = layoutGitGraph([
    commit('d', ['c']),
    commit('c', ['b']),
    commit('b', ['a']),
    commit('a', []),
  ])
  const cells = rows.map((row) => edges(gitGraphCellGeometry(row)))

  for (let index = 0; index < cells.length - 1; index += 1) {
    expect(cells[index + 1]!.entries).toEqual(cells[index]!.exits)
  }
})

test('le tracé reste continu à travers un merge', () => {
  const rows = layoutGitGraph([
    commit('m', ['a', 'b']),
    commit('a', ['base']),
    commit('b', ['base']),
    commit('base', []),
  ])
  const cells = rows.map((row) => edges(gitGraphCellGeometry(row)))

  for (let index = 0; index < cells.length - 1; index += 1) {
    expect(cells[index + 1]!.entries).toEqual(cells[index]!.exits)
  }
})

test('le graphe se décrit pour qui ne le voit pas', () => {
  const rows = layoutGitGraph([
    commit('m', ['a', 'b']),
    commit('a', ['base']),
    commit('b', ['base']),
    commit('base', []),
  ])

  expect(gitGraphRowLabel(rows[0]!)).toBe('fusion de 2 parents, voie 1 sur 2')
  expect(gitGraphRowLabel(rows[2]!)).toBe('commit, voie 2 sur 2')
  expect(gitGraphRowLabel(layoutGitGraph([commit('seul', [])])[0]!)).toBe('commit')
})
