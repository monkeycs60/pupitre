import { expect, test } from 'bun:test'
import { ancestorDirectories, buildCodeTree, flattenCodeTree, matchCodePaths } from './codeTree'
import { codeGraphPaths, layoutCodeGraph, parseCodeRefs } from './codeGraphLayout'
import { highlightCode, languageForPath, splitHighlightedHtml } from './codeHighlight'
import { defaultCodeSource } from './codeFormat'
import type { CodeCommitSummary } from './types'

function commit(sha: string, parents: string[]): CodeCommitSummary {
  return { sha, parents, refs: [], author: 'A', authoredAt: '2026-09-13T10:00:00.000Z', subject: sha, conversations: [] }
}

test("l'arbre range les dossiers avant les fichiers et fusionne les dossiers à enfant unique", () => {
  const root = buildCodeTree(['README.md', 'apps/api/src/routes.js', 'apps/api/src/stats.js', 'apps/web/index.ts', 'a.ts'])

  const collapsed = flattenCodeTree(root, new Set())
  expect(collapsed.map((row) => row.label)).toEqual(['apps', 'a.ts', 'README.md'])

  const expanded = flattenCodeTree(root, new Set(['apps', 'apps/api/src']))
  expect(expanded.map((row) => [row.label, row.depth])).toEqual([
    ['apps', 0], ['api/src', 1], ['routes.js', 2], ['stats.js', 2], ['web', 1], ['a.ts', 0], ['README.md', 0],
  ])
  expect(ancestorDirectories('apps/api/src/routes.js')).toEqual(['apps', 'apps/api', 'apps/api/src'])
})

test('la recherche floue favorise le nom de fichier et les suites contiguës', () => {
  const matches = matchCodePaths(['src/router/tests.ts', 'apps/api/_routes/routes.js', 'docs/routing.md'], 'routes')

  expect(matches.map((match) => match.path)).toEqual(['apps/api/_routes/routes.js', 'src/router/tests.ts'])
  expect(matches[0]!.indices).toEqual([17, 18, 19, 20, 21, 22])
  expect(matchCodePaths(['a.ts'], '   ')).toEqual([])
})

test('le graphe ouvre une lane pour une branche fusionnée puis la referme', () => {
  const rows = layoutCodeGraph([
    commit('m', ['a', 'b']),
    commit('b', ['a']),
    commit('a', []),
  ])

  expect(rows.map((row) => [row.commit.sha, row.lane, row.hasIncoming])).toEqual([
    ['m', 0, false], ['b', 1, true], ['a', 0, true],
  ])
  expect(rows[0]!.segments).toEqual([{ from: 0, to: 0, kind: 'parent' }, { from: 0, to: 1, kind: 'parent' }])
  expect(codeGraphPaths(rows[1]!, 28).map((path) => path.lane)).toEqual([1, 0, 0])
})

test("l'état du code par défaut est le worktree de la conversation, sinon le premier dépôt", () => {
  const source = (path: string, main: boolean, conversationIds: string[]) => ({
    path, repositoryPath: '/repo', repositoryLabel: 'repo', branch: null, head: null, detached: false, main,
    conversations: conversationIds.map((id) => ({ id, title: id, provider: 'codex' as const })),
  })
  const sources = [source('/repo', true, ['c1', 'c2']), source('/wt/c2', false, ['c2'])]

  expect(defaultCodeSource(sources, 'c2', '/wt/c2/')).toBe('/wt/c2')
  expect(defaultCodeSource(sources, 'c1', null)).toBe('/repo')
  expect(defaultCodeSource(sources, null, null)).toBe('/repo')
  expect(defaultCodeSource([], 'c1', null)).toBeNull()
})

test('les refs distinguent HEAD, branches locales, distantes et tags', () => {
  expect(parseCodeRefs(['HEAD -> develop', 'origin/develop', 'origin/HEAD', 'tag: v4.1', 'feature/x'])).toEqual([
    { label: 'develop', kind: 'head' },
    { label: 'origin/develop', kind: 'remote' },
    { label: 'v4.1', kind: 'tag' },
    { label: 'feature/x', kind: 'local' },
  ])
})

test('le découpage en lignes referme et rouvre les jetons multi-lignes', () => {
  expect(splitHighlightedHtml('<span class="hljs-comment">/* a\nb */</span>\n<span class="hljs-keyword">const</span> x')).toEqual([
    '<span class="code-tok-comment">/* a</span>',
    '<span class="code-tok-comment">b */</span>',
    '<span class="code-tok-keyword">const</span> x',
  ])
})

test('colore un fichier TypeScript et échappe le texte brut des langages inconnus', async () => {
  expect(languageForPath('ui/src/App.tsx')).toBe('typescript')
  expect(languageForPath('Dockerfile')).toBe('dockerfile')
  expect(languageForPath('.env.local')).toBe('ini')

  const lines = await highlightCode("const a = '<b>'\n", 'x.ts')
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain('<span class="code-tok-keyword">const</span>')
  expect(lines[0]).toContain('&lt;b&gt;')

  expect(await highlightCode('<script>\n', 'notes.unknown')).toEqual(['&lt;script&gt;'])
})
