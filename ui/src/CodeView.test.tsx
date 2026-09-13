import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { CodeBranchChanges, CodeCommitDetail, CodeCommitSummary, CodeFileList, CodeGraphPage, CodeSource, Conversation, Project } from './types'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render, screen, waitFor, within } = await import('@testing-library/react')
const { CodeView } = await import('./CodeView')
const { resetCodeViewMemory } = await import('./codeViewMemory')
const defaultFetch = globalThis.fetch

afterEach(() => {
  cleanup()
  resetCodeViewMemory()
  window.localStorage.clear()
  globalThis.fetch = defaultFetch
})

const project: Project = {
  id: 'project-1',
  name: 'Pupitre',
  path: '/tmp/pupitre',
  permission_mode: 'acceptEdits',
  filesystem_scope: 'project-and-ai-roots',
  pinned: false,
  created_at: '2026-08-17T00:00:00.000Z',
  default_preset_id: null,
  default_review_preset_id: null,
  default_correction_preset_id: null,
  auto_rescan: false,
}

const baseConversation: Conversation = {
  id: 'conversation-1',
  project_id: project.id,
  title: 'Lecteur de code',
  summary: '',
  provider: 'claude',
  model: 'claude-opus-5',
  effort: 'high',
  speed: 'standard',
  permission_mode: 'acceptEdits',
  continued_from: null,
  routine_id: null,
  worktree_path: '/tmp/worktrees/feature',
  created_on_branch: 'main',
  ticket_id: null,
  cli_session_id: null,
  pinned: false,
  title_locked: false,
  digest_turn: 0,
  archived: false,
  deleted_at: null,
  created_at: '2026-08-17T00:00:00.000Z',
  updated_at: '2026-08-17T00:00:00.000Z',
}

const link = { id: baseConversation.id, title: baseConversation.title, provider: 'claude' as const }
const DIFF = 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,2 @@\n-export const a = 0\n+export const a = 1\n export const b = 2\n'

function summary(sha: string, subject: string, authoredAt: string, extra: Partial<CodeCommitSummary> = {}): CodeCommitSummary {
  return { sha: sha.repeat(40).slice(0, 40), parents: [], refs: [], author: 'Clément', authoredAt, subject, conversations: [], agent: null, ...extra }
}

function source(path: string, repositoryLabel: string, branch: string, main: boolean, conversations = [] as CodeSource['conversations']): CodeSource {
  return { path, repositoryPath: `/tmp/${repositoryLabel}`, repositoryLabel, branch, head: null, detached: false, main, conversations, ref: null, updatedAt: null }
}

interface Fixture {
  sources: CodeSource[]
  files: Record<string, CodeFileList>
  graphs: Record<string, CodeGraphPage>
  detail?: CodeCommitDetail
  changes?: Record<string, CodeBranchChanges>
}

function mockApi(fixture: Fixture): string[] {
  const calls: string[] = []
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    const params = new URL(url, 'http://pupitre.test').searchParams
    const sourcePath = params.get('source') ?? ''
    if (url.includes('/code/sources')) return Response.json(fixture.sources)
    if (url.includes('/code/files')) return Response.json(fixture.files[sourcePath])
    if (url.includes('/code/graph')) return Response.json(fixture.graphs[sourcePath])
    if (url.includes('/code/commit')) return Response.json(fixture.detail)
    if (url.includes('/code/changes')) return Response.json(fixture.changes?.[sourcePath])
    if (url.includes('/code/conversation')) return Response.json({ conversationId: params.get('conversationId'), total: 0, repositories: [] })
    if (url.includes('/code/diff')) return Response.json({ diff: DIFF })
    if (url.includes('/code/file')) {
      return Response.json({ path: params.get('path'), ref: 'worktree', content: 'export const a = 1\nexport const b = 2\n', size: 38, binary: false, tooLarge: false })
    }
    if (url.includes('/conversations')) return Response.json([baseConversation])
    return Response.json({})
  }) as typeof fetch
  return calls
}

function singleFixture(): Fixture {
  const head = summary('b', 'ajoute le lecteur', '2026-09-12T10:00:00.000Z', { refs: ['HEAD -> feature/code'], conversations: [link] })
  const base = summary('a', 'socle', '2026-09-01T10:00:00.000Z', { refs: ['main'] })
  head.parents = [base.sha]
  return {
    sources: [
      source('/tmp/pupitre', 'pupitre', 'main', true),
      source('/tmp/worktrees/feature', 'pupitre', 'feature/code', false, [link]),
    ],
    files: {
      '/tmp/worktrees/feature': { paths: ['README.md', 'src/app.ts'], submodules: [], dirty: [{ path: 'src/app.ts', status: 'M' }], truncated: false },
    },
    graphs: {
      '/tmp/worktrees/feature': { head: head.sha, currentBranch: 'feature/code', base: 'main', focus: [head.sha], focusCommits: [head], skip: 0, hasMore: false, commits: [head, base] },
    },
    detail: { ...head, email: 'clement@example.test', body: '', files: [{ path: 'src/app.ts', previousPath: null, status: 'M', added: 3, removed: 1 }], filesTruncated: false },
    changes: {
      '/tmp/worktrees/feature': { base: 'main', from: 'main', head: head.sha, files: [{ path: 'src/app.ts', previousPath: null, status: 'M', added: 3, removed: 1 }], filesTruncated: false },
    },
  }
}

test('ouvre le worktree de la conversation, lit un fichier et remonte à la conversation du commit', async () => {
  const calls = mockApi(singleFixture())
  const onOpenConversation = mock(() => {})
  render(createElement(CodeView, { project, conversation: baseConversation, ticketLinks: new Map(), onOpenConversation }))

  expect(await screen.findByText('Worktree de la conversation')).toBeTruthy()
  await waitFor(() => expect(calls.some((url) => url.includes('/code/files') && url.includes(encodeURIComponent('/tmp/worktrees/feature')))).toBe(true))

  fireEvent.click(await screen.findByRole('treeitem', { name: 'src' }))
  fireEvent.click(await screen.findByRole('treeitem', { name: /app\.ts/ }))
  await waitFor(() => expect(document.querySelectorAll('.code-line')).toHaveLength(2))
  expect(document.querySelector('.code-breadcrumb strong')?.textContent).toBe('app.ts')
  expect(screen.getByText('modifié')).toBeTruthy()

  expect(await screen.findByText('Produit par une conversation')).toBeTruthy()
  fireEvent.click(screen.getByTitle('Ouvrir la conversation'))
  expect(onOpenConversation).toHaveBeenCalledWith(baseConversation.id)

  fireEvent.click(screen.getByTitle('Voir le diff de src/app.ts dans ce commit'))
  await waitFor(() => expect(document.querySelectorAll('.code-diff-line.is-addition')).toHaveLength(1))
  expect(screen.getByRole('tab', { name: 'Diff' }).getAttribute('aria-selected')).toBe('true')
  expect(document.querySelector('.code-reader-chip')?.textContent).toContain('Commit bbbbbbbb')

  fireEvent.click(screen.getByRole('button', { name: 'Courant' }))
  await waitFor(() => expect(document.querySelectorAll('.code-line')).toHaveLength(2))
  expect(screen.getByRole('tab', { name: 'Code' }).getAttribute('aria-selected')).toBe('true')
})

test('agrandit le graphe en table puis revient au fichier ouvert avec Échap', async () => {
  mockApi(singleFixture())
  render(createElement(CodeView, { project, conversation: baseConversation, ticketLinks: new Map(), onOpenConversation: () => {} }))

  fireEvent.click(await screen.findByRole('treeitem', { name: 'README.md' }))
  await waitFor(() => expect(document.querySelectorAll('.code-graph-row')).toHaveLength(2))

  fireEvent.click(screen.getByRole('button', { name: 'Agrandir' }))
  expect(await screen.findByRole('button', { name: 'Retour à README.md' })).toBeTruthy()
  expect(document.querySelector('.code-sidebar')?.hasAttribute('hidden')).toBe(true)
  expect(document.querySelectorAll('.code-graph-row.is-table')).toHaveLength(2)
  expect(screen.getByText('Origine')).toBeTruthy()

  fireEvent.keyDown(window, { key: 'Escape' })
  await waitFor(() => expect(document.querySelector('.code-view')?.classList.contains('is-graph-expanded')).toBe(false))
  expect(document.querySelector('.code-breadcrumb strong')?.textContent).toBe('README.md')

  fireEvent.keyDown(window, { key: 'p', ctrlKey: true })
  expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'Chercher un fichier ou du texte' }))
})

test('retrouve l’état de l’onglet au retour et liste le diff du chantier', async () => {
  mockApi(singleFixture())
  const props = { project, conversation: baseConversation, ticketLinks: new Map(), onOpenConversation: () => {} }
  const first = render(createElement(CodeView, props))
  fireEvent.click(await screen.findByRole('treeitem', { name: 'README.md' }))
  await waitFor(() => expect(document.querySelector('.code-breadcrumb strong')?.textContent).toBe('README.md'))
  first.unmount()

  render(createElement(CodeView, props))
  await waitFor(() => expect(document.querySelector('.code-breadcrumb strong')?.textContent).toBe('README.md'))

  fireEvent.click(await screen.findByRole('button', { name: /Diff du chantier/ }))
  fireEvent.click(await screen.findByTitle('Voir le diff de src/app.ts sur la branche'))
  await waitFor(() => expect(document.querySelectorAll('.code-diff-line.is-addition')).toHaveLength(1))
  expect(document.querySelector('.code-reader-chip')?.textContent).toContain('Diff du chantier')
  expect(document.querySelector('.code-commit-file.is-active strong')?.textContent).toBe('app.ts')
})

test('réunit les worktrees d’un ticket, filtre par conversation et par dépôt', async () => {
  const conversation = { ...baseConversation, worktree_path: '/tmp/apps/api-tech1234' }
  const apiCommit = summary('c', 'api du ticket', '2026-09-10T10:00:00.000Z', { conversations: [link] })
  const webCommit = summary('d', 'écran du ticket', '2026-09-11T10:00:00.000Z')
  mockApi({
    sources: [
      source('/tmp/apps/api', 'apps/api', 'develop', true),
      source('/tmp/apps/web', 'apps/web', 'develop', true),
      source('/tmp/apps/api-tech1234', 'apps/api', 'feature/TECH-1234', false, [{ ...link }]),
      source('/tmp/apps/web-tech1234', 'apps/web', 'feature/TECH-1234', false),
    ],
    files: {
      '/tmp/apps/api-tech1234': { paths: ['src/server.ts'], submodules: [], dirty: [], truncated: false },
      '/tmp/apps/web-tech1234': { paths: ['src/App.tsx'], submodules: [], dirty: [], truncated: false },
    },
    graphs: {
      '/tmp/apps/api-tech1234': { head: apiCommit.sha, currentBranch: 'feature/TECH-1234', base: 'develop', focus: [apiCommit.sha], focusCommits: [apiCommit], skip: 0, hasMore: false, commits: [apiCommit] },
      '/tmp/apps/web-tech1234': { head: webCommit.sha, currentBranch: 'feature/TECH-1234', base: 'develop', focus: [webCommit.sha], focusCommits: [webCommit], skip: 0, hasMore: false, commits: [webCommit] },
    },
    detail: { ...apiCommit, email: 'c@example.test', body: '', files: [], filesTruncated: false },
  })
  render(createElement(CodeView, { project, conversation, ticketLinks: new Map(), onOpenConversation: () => {} }))

  expect(await screen.findByText('Chantier sur 2 dépôts')).toBeTruthy()
  expect(await screen.findByRole('treeitem', { name: 'api/src' })).toBeTruthy()
  await waitFor(() => expect(document.querySelectorAll('.code-graph-row')).toHaveLength(2))
  expect([...document.querySelectorAll('.code-graph-row .code-repo-badge')].map((badge) => badge.textContent)).toEqual(['web', 'api'])
  expect(screen.getByRole('button', { name: /Branche/ }).getAttribute('aria-pressed')).toBe('true')

  fireEvent.click(screen.getByRole('button', { name: /Conversations/ }))
  fireEvent.click(screen.getByRole('menuitemradio', { name: /Avec une conversation/ }))
  await waitFor(() => expect(document.querySelectorAll('.code-graph-row')).toHaveLength(1))
  expect(document.querySelector('.code-graph-row .code-repo-badge')?.textContent).toBe('api')

  fireEvent.click(screen.getByRole('button', { name: /Avec conversation/ }))
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Tous les commits' }))
  fireEvent.click(screen.getByRole('button', { name: 'web' }))
  await waitFor(() => expect(document.querySelectorAll('.code-graph-row')).toHaveLength(1))
  expect(screen.getByRole('button', { name: 'web' }).getAttribute('aria-pressed')).toBe('false')

  fireEvent.click(document.querySelector('.code-source-button')!)
  fireEvent.change(screen.getByRole('searchbox', { name: 'Filtrer les états du code' }), { target: { value: 'web develop' } })
  const options = within(screen.getByRole('listbox', { name: 'États du code' })).getAllByRole('option')
  expect(options.map((option) => option.getAttribute('title'))).toEqual(['/tmp/apps/api\n/tmp/apps/web', '/tmp/apps/web'])
})
