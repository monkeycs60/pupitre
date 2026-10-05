import { expect, test } from 'bun:test'
import { toolDiff } from './toolDiff'
import type { EventBlock } from './eventBlocks'

function tool(toolName: string, input: unknown): Extract<EventBlock, { kind: 'tool' }> {
  return { kind: 'tool', id: 'tool-1', toolId: '1', toolName, input, output: 'ok', images: [] }
}

test('une modification montre les lignes retirées puis ajoutées', () => {
  expect(toolDiff(tool('Edit', { file_path: '/a.ts', old_string: 'const a = 1\nconst b = 2', new_string: 'const a = 3' }))).toEqual([
    { kind: 'removed', text: 'const a = 1' },
    { kind: 'removed', text: 'const b = 2' },
    { kind: 'added', text: 'const a = 3' },
  ])
})

test('une écriture montre tout le contenu comme ajouté et MultiEdit sépare ses remplacements', () => {
  expect(toolDiff(tool('Write', { file_path: '/a.ts', content: 'x\ny\n' }))?.map((line) => line.kind)).toEqual(['added', 'added'])
  expect(toolDiff(tool('MultiEdit', { edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] }))?.map((line) => line.kind))
    .toEqual(['removed', 'added', 'gap', 'removed', 'added'])
})

test('un apply_patch Codex garde ses fichiers, son contexte et ses changements', () => {
  const command = "apply_patch <<'EOF'\n*** Begin Patch\n*** Update File: src/a.ts\n@@ function f\n const x = 1\n-old\n+new\n*** End Patch\nEOF"
  expect(toolDiff(tool('shell', { command }))).toEqual([
    { kind: 'file', text: 'src/a.ts' },
    { kind: 'gap', text: 'function f' },
    { kind: 'context', text: 'const x = 1' },
    { kind: 'removed', text: 'old' },
    { kind: 'added', text: 'new' },
  ])
})

test('une commande ou une lecture n’a pas de diff', () => {
  expect(toolDiff(tool('Bash', { command: 'ls' }))).toBeNull()
  expect(toolDiff(tool('Read', { file_path: '/a.ts' }))).toBeNull()
})
