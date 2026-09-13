import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { CodeCommitDetail, CodeFileList, CodeGraphPage, CodeSource, Conversation, Project } from './types'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { CodeView } = await import('./CodeView')
const defaultFetch = globalThis.fetch

afterEach(() => {
  cleanup()
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

const conversation: Conversation = {
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

const link = { id: conversation.id, title: conversation.title, provider: 'claude' as const }
const headSha = 'b'.repeat(40)
const baseSha = 'a'.repeat(40)

const sources: CodeSource[] = [
  { path: '/tmp/pupitre', repositoryPath: '/tmp/pupitre', repositoryLabel: 'pupitre', branch: 'main', head: baseSha, detached: false, main: true, conversations: [] },
  { path: '/tmp/worktrees/feature', repositoryPath: '/tmp/pupitre', repositoryLabel: 'pupitre', branch: 'feature/code', head: headSha, detached: false, main: false, conversations: [link] },
]

const files: CodeFileList = {
  paths: ['README.md', 'src/app.ts'],
  dirty: [{ path: 'src/app.ts', status: 'M' }],
  truncated: false,
}

const graph: CodeGraphPage = {
  head: headSha,
  currentBranch: 'feature/code',
  base: 'main',
  focus: [headSha],
  skip: 0,
  hasMore: false,
  commits: [
    { sha: headSha, parents: [baseSha], refs: ['HEAD -> feature/code'], author: 'Clément', authoredAt: '2026-09-12T10:00:00.000Z', subject: 'ajoute le lecteur', conversations: [link] },
    { sha: baseSha, parents: [], refs: ['main'], author: 'Clément', authoredAt: '2026-09-01T10:00:00.000Z', subject: 'socle', conversations: [] },
  ],
}

const detail: CodeCommitDetail = {
  ...graph.commits[0]!,
  email: 'clement@example.test',
  body: '',
  files: [{ path: 'src/app.ts', previousPath: null, status: 'M', added: 3, removed: 1 }],
  filesTruncated: false,
}

function mockApi(): string[] {
  const calls: string[] = []
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    if (url.includes('/code/sources')) return Response.json(sources)
    if (url.includes('/code/files')) return Response.json(files)
    if (url.includes('/code/graph')) return Response.json(graph)
    if (url.includes('/code/commit')) return Response.json(detail)
    if (url.includes('/code/file')) {
      return Response.json({ path: 'src/app.ts', ref: 'worktree', content: 'export const a = 1\nexport const b = 2\n', size: 38, binary: false, tooLarge: false })
    }
    if (url.includes('/conversations')) return Response.json([conversation])
    return Response.json({})
  }) as typeof fetch
  return calls
}

test('ouvre le worktree de la conversation, lit un fichier et remonte à la conversation du commit', async () => {
  const calls = mockApi()
  const onOpenConversation = mock(() => {})
  render(createElement(CodeView, { project, conversation, ticketLinks: new Map(), onOpenConversation }))

  expect(await screen.findByText('Worktree de la conversation')).toBeTruthy()
  await waitFor(() => expect(calls.some((url) => url.includes('/code/files') && url.includes(encodeURIComponent('/tmp/worktrees/feature')))).toBe(true))

  fireEvent.click(await screen.findByRole('treeitem', { name: 'src' }))
  fireEvent.click(await screen.findByRole('treeitem', { name: /app\.ts/ }))
  await waitFor(() => expect(document.querySelectorAll('.code-line')).toHaveLength(2))
  expect(document.querySelector('.code-breadcrumb strong')?.textContent).toBe('app.ts')
  expect(screen.getByText('modifié')).toBeTruthy()

  expect(await screen.findByText('Produit par une conversation')).toBeTruthy()
  fireEvent.click(screen.getByTitle('Ouvrir la conversation'))
  expect(onOpenConversation).toHaveBeenCalledWith(conversation.id)
})

test('agrandit le graphe en table puis revient au fichier ouvert avec Échap', async () => {
  mockApi()
  render(createElement(CodeView, { project, conversation, ticketLinks: new Map(), onOpenConversation: () => {} }))

  fireEvent.click(await screen.findByRole('treeitem', { name: 'README.md' }))
  await waitFor(() => expect(document.querySelectorAll('.code-graph-row')).toHaveLength(2))

  fireEvent.click(screen.getByRole('button', { name: 'Agrandir' }))
  expect(await screen.findByRole('button', { name: 'Retour à README.md' })).toBeTruthy()
  expect(document.querySelector('.code-sidebar')?.hasAttribute('hidden')).toBe(true)
  expect(document.querySelectorAll('.code-graph-row.is-table')).toHaveLength(2)
  expect(screen.getByText('Conversation')).toBeTruthy()

  fireEvent.keyDown(window, { key: 'Escape' })
  await waitFor(() => expect(document.querySelector('.code-view')?.classList.contains('is-graph-expanded')).toBe(false))
  expect(document.querySelector('.code-breadcrumb strong')?.textContent).toBe('README.md')

  fireEvent.keyDown(window, { key: 'p', ctrlKey: true })
  expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'Chercher un fichier ou du texte' }))
})
