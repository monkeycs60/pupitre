import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { CodeConversationCommits } from './types'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const { ConversationWorkspaceCard } = await import('./ConversationWorkspaceCard')
const defaultFetch = globalThis.fetch

afterEach(() => {
  cleanup()
  globalThis.fetch = defaultFetch
})

function commit(sha: string, subject: string) {
  return { sha: sha.repeat(40), parents: [], refs: [], author: 'Clément', authoredAt: '2026-09-12T10:00:00.000Z', subject, conversations: [], agent: null }
}

test('résume les commits de la conversation par dépôt et déplie leurs changements', async () => {
  const data: CodeConversationCommits = {
    conversationId: 'conversation-1',
    total: 3,
    repositories: [
      { repositoryPath: '/mono/apps/hapigator', repositoryLabel: 'apps/hapigator', commits: [commit('a', 'gate adaptative'), commit('b', 'quota')] },
      { repositoryPath: '/mono/apps/reactor', repositoryLabel: 'apps/reactor', commits: [commit('c', 'drawer')] },
    ],
    ticket: null,
  }
  const changes = {
    truncated: false,
    repositories: [{
      repositoryLabel: 'hapigator', worktreePath: '/mono/apps/hapigator-t1', branch: 'feature/T-1', kind: 'commits', commits: 2, title: null,
      files: [{
        path: 'lib/gate.js', previousPath: null, status: 'modified', added: 1, removed: 1, binary: false, generated: false, truncated: false,
        absolutePath: '/mono/apps/hapigator-t1/lib/gate.js', firstLine: 2,
        diff: 'diff --git a/lib/gate.js b/lib/gate.js\n--- a/lib/gate.js\n+++ b/lib/gate.js\n@@ -1,2 +1,2 @@\n const a = 1\n-const b = 2\n+const b = 3',
      }],
    }],
  }
  globalThis.fetch = mock(async (input: RequestInfo | URL) => Response.json(String(input).endsWith('/changes') ? changes : data)) as unknown as typeof fetch

  render(createElement(ConversationWorkspaceCard, { projectId: 'p1', conversationId: 'conversation-1' }))

  expect(await screen.findByText('3 commits sur 2 dépôts')).toBeTruthy()
  expect([...document.querySelectorAll('.code-workspace-card-repos .code-repo-badge')].map((badge) => badge.textContent)).toEqual(['hapigator', 'reactor'])
  expect(screen.getByText('gate adaptative')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Voir les changements' }))
  expect(await screen.findByText('1 fichier modifié')).toBeTruthy()
  expect([...document.querySelectorAll('.changes-diff-line')].map((line) => line.className.replace('changes-diff-line is-', ''))).toEqual(['context', 'deletion', 'addition'])
  expect(screen.getByText('feature/T-1')).toBeTruthy()
})

test('sans commit propre, montre le travail du ticket et qui l’a commité', async () => {
  const data: CodeConversationCommits = {
    conversationId: 'reader',
    total: 0,
    repositories: [],
    ticket: {
      key: 'TECH-24128',
      branchCommits: 177,
      total: 21,
      repositories: [
        { repositoryPath: '/mono/apps/hapigator', repositoryLabel: 'apps/hapigator', commits: [commit('a', 'migration'), commit('b', 'reprise')] },
        { repositoryPath: '/mono/apps/reactor', repositoryLabel: 'apps/reactor', commits: [commit('c', 'écran')] },
      ],
      conversations: [{ id: 'worker', title: 'Script migration Match AI', commits: 21 }],
    },
  }
  globalThis.fetch = mock(async () => Response.json(data)) as unknown as typeof fetch

  render(createElement(ConversationWorkspaceCard, { projectId: 'p1', conversationId: 'reader' }))

  expect(await screen.findByText('TECH-24128 : 177 commits, dont 21 reliés à des conversations')).toBeTruthy()
  expect(screen.getByText('Commité par Script migration Match AI')).toBeTruthy()
  expect(screen.getByRole('article', { name: 'Travail du ticket' })).toBeTruthy()
  expect(document.querySelectorAll('.code-workspace-card-repos li')).toHaveLength(2)
  expect(screen.getByRole('button', { name: 'Voir les changements' })).toBeTruthy()
})

test('reste invisible tant que ni la conversation ni son ticket n’ont rien commité', async () => {
  globalThis.fetch = mock(async () => Response.json({ conversationId: 'c', total: 0, repositories: [], ticket: { key: 'TECH-1', branchCommits: 0, total: 0, repositories: [], conversations: [] } })) as unknown as typeof fetch
  const { container } = render(createElement(ConversationWorkspaceCard, { projectId: 'p1', conversationId: 'c' }))
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(container.innerHTML).toBe('')
})

test('ouvre le worktree dans VS Code avec les fichiers modifiés', async () => {
  const data: CodeConversationCommits = {
    conversationId: 'conversation-1',
    total: 1,
    repositories: [{ repositoryPath: '/mono/apps/reactor', repositoryLabel: 'apps/reactor', commits: [commit('c', 'drawer')] }],
    ticket: null,
  }
  const posted: Array<{ url: string; body: unknown }> = []
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (init?.method === 'POST') {
      posted.push({ url, body: JSON.parse(String(init.body)) })
      return Response.json({ changed: 3, openedFiles: 3, folders: [] })
    }
    return Response.json(data)
  }) as unknown as typeof fetch

  render(createElement(ConversationWorkspaceCard, { projectId: 'p1', conversationId: 'conversation-1' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Ouvrir dans VS Code' }))

  await new Promise((settle) => setTimeout(settle, 0))
  expect(posted).toEqual([{ url: expect.stringContaining('/api/conversations/conversation-1/editor'), body: { changed: true } }])
})
