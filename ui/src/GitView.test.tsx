import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { Conversation, Project } from './types'

if (typeof document === 'undefined') GlobalRegistrator.register()
const { cleanup, render, screen } = await import('@testing-library/react')
const { GitView } = await import('./GitView')
const defaultFetch = globalThis.fetch
afterEach(() => { cleanup(); globalThis.fetch = defaultFetch })

const project = { id: 'p1', name: 'Pupitre', path: '/tmp/pupitre', permission_mode: 'acceptEdits', filesystem_scope: 'project-and-ai-roots', pinned: false, created_at: '', default_preset_id: null, auto_rescan: false } satisfies Project
const conversation = { id: 'c1', project_id: 'p1', title: 'Navigation', summary: '', provider: 'codex', model: 'gpt-5.6-sol', effort: 'high', speed: 'standard', continued_from: null, routine_id: null, worktree_path: null, created_on_branch: null, ticket_id: null, ticket_instruction: null, cli_session_id: null, pinned: false, message: '' } satisfies Conversation

test('affiche le diff vivant et l historique de la conversation', async () => {
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/git')) return Response.json({ head: 'abc', currentBranch: 'main', commits: [], branchCommitShas: [], branches: [], worktrees: [], dirtyFiles: [], filePaths: [], ahead: 0, behind: 0, incoming: [], conflicts: [], headParents: [], branchBase: null })
    if (url.endsWith('/diff')) return Response.json({ base: 'HEAD', head: 'WORKTREE', diff: 'diff --git a/a.ts b/a.ts\n+a' })
    return Response.json({}, { status: 404 })
  }) as typeof fetch
  render(createElement(GitView, { project, conversation, onConversationBack: () => {} }))
  expect(await screen.findByText('a.ts')).toBeTruthy()
  expect(screen.getByRole('button', { name: /Historique/ })).toBeTruthy()
})
