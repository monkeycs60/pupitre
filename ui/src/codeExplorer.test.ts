import { expect, test } from 'bun:test'
import { highlightCode, languageForPath, splitHighlightedHtml } from './codeHighlight'
import { buildCodeScopes, codeScopeMatches, defaultCodeScope, fromScopePath, isStaleScope, ticketKeyOfSource, toScopePath } from './codeScopes'
import type { CodeSource } from './types'

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
    ref: null,
    updatedAt: null,
  }
}

test('un ticket sans worktree se lit depuis ses branches ; les vieilles branches sont masquées', () => {
  const branch = (repositoryLabel: string, ref: string, updatedAt: string): CodeSource => ({
    ...source(`/mono/${repositoryLabel}#${ref}`, repositoryLabel, ref.replace(/^origin\//, ''), false),
    ref,
    updatedAt,
  })
  const now = Date.parse('2026-09-13T12:00:00Z')
  const sources = [
    source('/mono/apps/api', 'apps/api', 'develop', true),
    source('/mono/apps/web', 'apps/web', 'develop', true),
    source('/mono/wt/feature-TECH-24128', 'mono', 'feature-TECH-24128', false),
    branch('apps/api', 'feature/TECH-24128', '2026-09-01T10:00:00Z'),
    branch('apps/api', 'origin/feature/TECH-24128', '2026-09-01T10:00:00Z'),
    branch('apps/web', 'origin/feature/TECH-24128', '2026-09-02T10:00:00Z'),
    branch('apps/api', 'feature/TECH-1010', '2025-01-01T10:00:00Z'),
    branch('apps/web', 'feature/TECH-1010', '2025-01-01T10:00:00Z'),
  ]

  const scopes = buildCodeScopes(sources)
  const ticket = scopes.find((scope) => scope.id === 'ticket:TECH-24128')!
  expect(ticket.sources.map((item) => item.path)).toEqual(['/mono/wt/feature-TECH-24128', '/mono/apps/api#feature/TECH-24128', '/mono/apps/web#origin/feature/TECH-24128'])
  expect(scopes.filter((scope) => scope.kind === 'ticket').map((scope) => scope.label)).toEqual(['TECH-24128', 'TECH-1010'])
  expect(isStaleScope(ticket, now)).toBe(false)
  expect(isStaleScope(scopes.find((scope) => scope.id === 'ticket:TECH-1010')!, now)).toBe(true)
  expect(defaultCodeScope(scopes, 'gone', '/deleted/feature-TECH-24128', 'main')).toBe('ticket:TECH-24128')
})

test('un ticket présent dans plusieurs dépôts se lit sur plusieurs dépôts', () => {
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
  expect(defaultCodeScope(scopes, 'c-gone', '/deleted/worktrees/feature-TECH-25008', 'main')).toBe('ticket:TECH-25008')
  expect(defaultCodeScope(scopes, 'c-gone', '/deleted/worktrees/feature-TECH-24986', 'main')).toBe('source:/mono/apps/api-tech24986')
  expect(defaultCodeScope(scopes, 'c-root', null)).toBe('source:/mono')
  expect(defaultCodeScope(scopes, null, null)).toBe('source:/mono')

  expect(codeScopeMatches(scopes[0]!, '25008 web')).toBe(true)
  expect(codeScopeMatches(scopes[0]!, 'reactor')).toBe(false)

  expect(toScopePath(scopes[0]!, '/mono/apps/web-tech25008', 'src/App.tsx')).toBe('web/src/App.tsx')
  expect(fromScopePath(scopes[0]!, 'web/src/App.tsx')).toEqual({ source: '/mono/apps/web-tech25008', path: 'src/App.tsx' })
  const single = scopes.find((scope) => scope.id === 'source:/mono')!
  expect(fromScopePath(single, 'apps/api')).toEqual({ source: '/mono', path: 'apps/api' })
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
