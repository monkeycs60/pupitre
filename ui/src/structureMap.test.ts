import { expect, test } from 'bun:test'
import {
  buildStructureTree,
  detectStructureSignals,
  layoutStructure,
  pruneStructureTree,
  summarizeStructure,
  type StructureSourceInput,
} from './structureMap'

function input(overrides: Partial<StructureSourceInput> = {}): StructureSourceInput {
  return {
    source: '/repo',
    label: 'repo',
    paths: [
      'src/api/users.ts', 'src/api/orders.ts', 'src/api/carts.ts', 'src/api/stock.ts',
      'src/ui/Button.tsx', 'src/ui/Card.tsx',
      'docs/guide.md',
      'vendor/a.js', 'vendor/b.js', 'vendor/c.js',
    ],
    changes: [],
    dirty: [],
    ...overrides,
  }
}

test('compte les fichiers créés, modifiés et supprimés, y compris ceux absents de l’arbre', () => {
  const tree = buildStructureTree([input({
    paths: [...input().paths, 'src/api/payments.ts'],
    changes: [
      { path: 'src/api/payments.ts', status: 'A', added: 120, removed: 0 },
      { path: 'src/api/users.ts', status: 'M', added: 4, removed: 2 },
      { path: 'src/api/legacy.ts', status: 'D', added: 0, removed: 80 },
    ],
  })])

  expect(summarizeStructure(tree)).toEqual({ files: 3, created: 1, modified: 1, deleted: 1, added: 124, removed: 82, directories: 1 })
})

test('un fichier non suivi par git compte comme créé et non commité', () => {
  const tree = buildStructureTree([input({ dirty: [{ path: 'src/ui/Modal.tsx', status: '?' }] })])
  const signals = detectStructureSignals(tree)

  expect(summarizeStructure(tree).created).toBe(1)
  expect(signals.find((signal) => signal.kind === 'uncommitted')?.nodes.map((entry) => entry.node.display)).toEqual(['src/ui/Modal.tsx'])
})

test('signale un dossier entièrement nouveau une seule fois, pas ses sous-dossiers', () => {
  const tree = buildStructureTree([input({
    paths: [...input().paths, 'src/helpers/format.ts', 'src/helpers/deep/parse.ts'],
    changes: [
      { path: 'src/helpers/format.ts', status: 'A', added: 10, removed: 0 },
      { path: 'src/helpers/deep/parse.ts', status: 'A', added: 10, removed: 0 },
    ],
  })])

  const signal = detectStructureSignals(tree).find((item) => item.kind === 'new-directory')
  expect(signal?.nodes.map((entry) => entry.node.display)).toEqual(['src/helpers'])
})

test('repère les fichiers créés au mauvais endroit ou au nom suspect', () => {
  const tree = buildStructureTree([input({
    paths: [...input().paths, 'PLAN.md', 'src/api/users.backup.ts', 'src/api/migrate.py', 'docs/notes.md', 'src/api/refunds.ts'],
    changes: [
      { path: 'PLAN.md', status: 'A', added: 30, removed: 0 },
      { path: 'src/api/users.backup.ts', status: 'A', added: 30, removed: 0 },
      { path: 'src/api/migrate.py', status: 'A', added: 30, removed: 0 },
      { path: 'docs/notes.md', status: 'A', added: 30, removed: 0 },
      { path: 'src/api/refunds.ts', status: 'A', added: 30, removed: 0 },
    ],
  })])

  const suspects = detectStructureSignals(tree).find((item) => item.kind === 'suspect')
  expect(suspects?.nodes.map((entry) => entry.node.display).sort()).toEqual(['PLAN.md', 'src/api/migrate.py', 'src/api/users.backup.ts'])
})

test('aucun signal quand le changement reste dans des fichiers existants', () => {
  const tree = buildStructureTree([input({ changes: [{ path: 'src/api/users.ts', status: 'M', added: 4, removed: 2 }] })])

  expect(detectStructureSignals(tree)).toEqual([])
})

test('replie les dossiers intacts en un bloc et garde les voisins des fichiers touchés', () => {
  const tree = buildStructureTree([input({ changes: [{ path: 'src/api/users.ts', status: 'M', added: 4, removed: 2 }] })])
  const layout = layoutStructure(pruneStructureTree(tree))
  const names = layout.buildings.map((rect) => `${rect.node.kind}:${rect.node.name}`).sort()

  expect(names).toEqual(['block:docs', 'block:ui', 'block:vendor', 'file:carts.ts', 'file:orders.ts', 'file:stock.ts', 'file:users.ts'])
  expect(layout.platforms.map((rect) => rect.node.name)).toEqual(['src', 'api'])
})

test('chaque bâtiment tient dans le terrain et aucun ne chevauche un autre', () => {
  const tree = buildStructureTree([input({
    changes: [
      { path: 'src/api/users.ts', status: 'M', added: 400, removed: 2 },
      { path: 'src/ui/Card.tsx', status: 'M', added: 1, removed: 0 },
      { path: 'vendor/a.js', status: 'M', added: 9, removed: 9 },
    ],
  })])
  const { buildings, size } = layoutStructure(pruneStructureTree(tree))

  expect(buildings).toHaveLength(10)
  for (const rect of buildings) {
    expect(rect.width).toBeGreaterThan(0)
    expect(rect.depth).toBeGreaterThan(0)
    expect(rect.x).toBeGreaterThanOrEqual(-size / 2)
    expect(rect.x + rect.width).toBeLessThanOrEqual(size / 2 + 1e-6)
    expect(rect.z + rect.depth).toBeLessThanOrEqual(size / 2 + 1e-6)
  }
  for (let left = 0; left < buildings.length; left++) {
    for (let right = left + 1; right < buildings.length; right++) {
      const a = buildings[left]!
      const b = buildings[right]!
      const overlap = a.x < b.x + b.width - 1e-6 && b.x < a.x + a.width - 1e-6 && a.z < b.z + b.depth - 1e-6 && b.z < a.z + a.depth - 1e-6
      expect(overlap).toBe(false)
    }
  }
})

test('un ticket sur deux dépôts donne une racine par dépôt', () => {
  const tree = buildStructureTree([
    input({ source: '/back', label: 'hapigator', changes: [{ path: 'src/api/users.ts', status: 'M', added: 1, removed: 0 }] }),
    input({ source: '/front', label: 'reactor', changes: [{ path: 'src/ui/Card.tsx', status: 'M', added: 1, removed: 0 }] }),
  ])
  const layout = layoutStructure(pruneStructureTree(tree))

  expect(layout.platforms.filter((rect) => rect.level === 0).map((rect) => rect.node.name).sort()).toEqual(['hapigator', 'reactor'])
  expect(summarizeStructure(tree).files).toBe(2)
})

test('fusionne une chaîne de dossiers à enfant unique en une seule plateforme', () => {
  const tree = buildStructureTree([input({
    paths: [...input().paths, 'packages/core/lib/index.ts'],
    changes: [{ path: 'packages/core/lib/index.ts', status: 'M', added: 3, removed: 1 }],
  })])
  const layout = layoutStructure(pruneStructureTree(tree))

  expect(layout.platforms.map((rect) => rect.node.name)).toEqual(['packages/core/lib'])
})

test('un snapshot généré ne compte pas comme gros fichier créé', () => {
  const tree = buildStructureTree([input({
    paths: [...input().paths, 'src/api/__snapshots__/users.test.ts.snap', 'src/api/billing.ts'],
    changes: [
      { path: 'src/api/__snapshots__/users.test.ts.snap', status: 'A', added: 2400, removed: 0 },
      { path: 'src/api/billing.ts', status: 'A', added: 520, removed: 0 },
    ],
  })])

  const large = detectStructureSignals(tree).find((item) => item.kind === 'large')
  expect(large?.nodes.map((entry) => entry.node.display)).toEqual(['src/api/billing.ts'])
})
