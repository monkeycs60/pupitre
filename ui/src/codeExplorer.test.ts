import { expect, test } from 'bun:test'
import { ancestorDirectories, buildCodeTree, flattenCodeTree, matchCodePaths } from './codeTree'
import { codeGraphPaths, layoutCodeGraph, parseCodeRefs } from './codeGraphLayout'
import { highlightCode, languageForPath, splitHighlightedHtml } from './codeHighlight'
import { buildCodeScopes, codeScopeMatches, defaultCodeScope, fromScopePath, ticketKeyOfSource, toScopePath } from './codeScopes'
import { mergeCodeCommits } from './codeGraphLayout'
import type { CodeCommitSummary, CodeSource } from './types'

function commit(sha: string, parents: string[], authoredAt = '2026-09-13T10:00:00.000Z'): CodeCommitSummary {
  return { sha, parents, refs: [], author: 'A', authoredAt, subject: sha, conversations: [], agent: null }
}

function source(path: string, repositoryLabel: string, branch: string | null, main: boolean, conversationIds: string[] = []): CodeSource {
  return {
    path,
    repositoryPath: `/mono/${repositoryLabel}`,
    repositoryLabel,
    branch,
    head: null,
    detached: branch === null,
    main,
    conversations: conversationIds.map((id) => ({ id, title: `conversation ${id}`, provider: 'claude' as const })),
  }
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

test('un ticket présent dans plusieurs dépôts devient un chantier multi-dépôts', () => {
  const sources = [
    source('/mono', 'mono', 'main', true, ['c-root']),
    source('/mono/apps/api', 'apps/api', 'develop', true),
    source('/mono/apps/web', 'apps/web', 'develop', true),
    source('/mono/apps/api-tech25008', 'apps/api', 'feature/TECH-25008', false, ['c1']),
    source('/mono/apps/web-tech25008', 'apps/web', 'feature/TECH-25008', false),
    source('/mono/apps/web-tech25008-before', 'apps/web', null, false),
    source('/mono/apps/api-tech24986', 'apps/api', 'issue/TECH-24986', false),
    source('/wt/codex-todo-0ba56b34-c533-4375-aafc', 'mono', 'codex/todo-0ba56b34-c533-4375-aafc', false),
  ]

  expect(ticketKeyOfSource(sources[3]!)).toBe('TECH-25008')
  expect(ticketKeyOfSource(sources[5]!)).toBe('TECH-25008')
  expect(ticketKeyOfSource(sources[7]!)).toBeNull()

  const scopes = buildCodeScopes(sources)
  expect(scopes.map((scope) => scope.id).slice(0, 2)).toEqual(['ticket:TECH-25008', 'mains'])
  expect(scopes[0]!.sources.map((item) => item.path)).toEqual(['/mono/apps/api-tech25008', '/mono/apps/web-tech25008'])
  expect(scopes[0]!.detail).toBe('api + web')
  expect(scopes.filter((scope) => scope.kind === 'source')).toHaveLength(sources.length)

  expect(defaultCodeScope(scopes, 'c1', null)).toBe('ticket:TECH-25008')
  expect(defaultCodeScope(scopes, 'c-root', null)).toBe('source:/mono')
  expect(defaultCodeScope(scopes, null, null)).toBe('source:/mono')

  expect(codeScopeMatches(scopes[0]!, '25008 web')).toBe(true)
  expect(codeScopeMatches(scopes[0]!, 'reactor')).toBe(false)

  expect(toScopePath(scopes[0]!, '/mono/apps/web-tech25008', 'src/App.tsx')).toBe('web/src/App.tsx')
  expect(fromScopePath(scopes[0]!, 'web/src/App.tsx')).toEqual({ source: '/mono/apps/web-tech25008', path: 'src/App.tsx' })
  const single = scopes.find((scope) => scope.id === 'source:/mono')!
  expect(fromScopePath(single, 'apps/api')).toEqual({ source: '/mono', path: 'apps/api' })
})

test('la fusion des historiques alterne par date sans casser l’ordre de chaque dépôt', () => {
  const merged = mergeCodeCommits([
    { source: '/api', repoLabel: 'api', repoIndex: 0, commits: [commit('a2', ['a1'], '2026-09-10T10:00:00Z'), commit('a1', [], '2026-09-12T10:00:00Z')] },
    { source: '/web', repoLabel: 'web', repoIndex: 1, commits: [commit('w1', [], '2026-09-11T10:00:00Z')] },
  ])

  expect(merged.map((item) => `${item.repoLabel}:${item.sha}`)).toEqual(['web:w1', 'api:a2', 'api:a1'])
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
