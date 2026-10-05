import { expect, test } from 'bun:test'
import { changedRange, toolDiff } from './toolDiff'
import type { EventBlock } from './eventBlocks'

function tool(toolName: string, input: unknown): Extract<EventBlock, { kind: 'tool' }> {
  return { kind: 'tool', id: 'tool-1', toolId: '1', toolName, input, output: 'ok', images: [] }
}

test('une modification montre les lignes retirées puis ajoutées', () => {
  expect(toolDiff(tool('Edit', { file_path: '/a.ts', old_string: 'const a = 1\nconst b = 2', new_string: 'const a = 3' }))).toEqual([{
    path: '/a.ts',
    status: 'modified',
    lines: [
      { kind: 'removed', text: 'const a = 1' },
      { kind: 'removed', text: 'const b = 2' },
      { kind: 'added', text: 'const a = 3' },
    ],
  }])
})

test('une écriture numérote son contenu et MultiEdit sépare ses remplacements', () => {
  expect(toolDiff(tool('Write', { file_path: '/a.ts', content: 'x\ny\n' }))?.[0].lines).toEqual([
    { kind: 'added', text: 'x', line: 1 },
    { kind: 'added', text: 'y', line: 2 },
  ])
  expect(toolDiff(tool('MultiEdit', { file_path: '/a.ts', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] }))?.[0].lines.map((line) => line.kind))
    .toEqual(['removed', 'added', 'gap', 'removed', 'added'])
})

test('un apply_patch sépare ses fichiers et garde contexte et repères', () => {
  const command = "apply_patch <<'EOF'\n*** Begin Patch\n*** Update File: src/a.ts\n@@ function f\n const x = 1\n-old\n+new\n*** Add File: src/b.ts\n+export const b = 1\n*** End Patch\nEOF"
  expect(toolDiff(tool('shell', { command }))).toEqual([
    {
      path: 'src/a.ts',
      status: 'modified',
      lines: [
        { kind: 'gap', text: 'function f' },
        { kind: 'context', text: 'const x = 1' },
        { kind: 'removed', text: 'old' },
        { kind: 'added', text: 'new' },
      ],
    },
    { path: 'src/b.ts', status: 'added', lines: [{ kind: 'added', text: 'export const b = 1' }] },
  ])
})

test('un file_change Codex numérote les lignes depuis les entêtes du diff unifié', () => {
  const diff = '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -10,3 +10,3 @@ export function f() {\n const x = 1\n-const y = 2\n+const y = 3\n const z = 4\n'
  expect(toolDiff(tool('file_change', { changes: [
    { path: '/repo/src/a.ts', kind: 'update', diff },
    { path: '/repo/src/new.ts', kind: 'add', diff: 'a\nb\n' },
  ] }))).toEqual([
    {
      path: '/repo/src/a.ts',
      status: 'modified',
      lines: [
        { kind: 'gap', text: 'export function f() {' },
        { kind: 'context', text: 'const x = 1', line: 10 },
        { kind: 'removed', text: 'const y = 2', line: 11 },
        { kind: 'added', text: 'const y = 3', line: 11 },
        { kind: 'context', text: 'const z = 4', line: 12 },
      ],
    },
    { path: '/repo/src/new.ts', status: 'added', lines: [{ kind: 'added', text: 'a', line: 1 }, { kind: 'added', text: 'b', line: 2 }] },
  ])
})

test('une commande ou une lecture n’a pas de diff', () => {
  expect(toolDiff(tool('Bash', { command: 'ls' }))).toBeNull()
  expect(toolDiff(tool('Read', { file_path: '/a.ts' }))).toBeNull()
})

test('le passage modifié d’une ligne se limite à ce qui diffère', () => {
  expect(changedRange('const y = 2', 'const y = 30')).toEqual({ before: [10, 11], after: [10, 12] })
  expect(changedRange('abc', 'xyz')).toBeNull()
})

test('un extrait perd son indentation commune, pas l’indentation relative', () => {
  expect(toolDiff(tool('Edit', { file_path: '/a.ts', old_string: '    if (x) {\n      y()', new_string: '    if (z) {\n      y()' }))?.[0].lines.map((line) => line.text))
    .toEqual(['if (x) {', '  y()', 'if (z) {', '  y()'])
})

test('le surlignage garde un préfixe commun court comme celui d’un return', () => {
  expect(changedRange('return "Hello " + name', 'return `Hello ${name}`')).toEqual({ before: [7, 22], after: [7, 22] })
})
