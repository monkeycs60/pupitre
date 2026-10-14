import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { CodeConversationCommits } from './types'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const { ConversationWorkspaceCard } = await import('./ConversationWorkspaceCard')
const defaultFetch = globalThis.fetch

globalThis.IntersectionObserver = class {
  constructor(private callback: IntersectionObserverCallback) {}
  observe(target: Element) { this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver) }
  disconnect() {}
  unobserve() {}
  takeRecords() { return [] }
} as unknown as typeof IntersectionObserver

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

test('commente une ligne du diff puis dépose la relecture dans le composer', async () => {
  const data: CodeConversationCommits = {
    conversationId: 'conversation-1',
    total: 1,
    repositories: [{ repositoryPath: '/mono/apps/hapigator', repositoryLabel: 'apps/hapigator', commits: [commit('a', 'gate')] }],
    ticket: null,
  }
  const changes = {
    truncated: false,
    repositories: [{
      repositoryLabel: 'hapigator', worktreePath: '/w/hapigator-t1', branch: 'feature/T-1', kind: 'commits', commits: 1, title: null,
      files: [{
        path: 'lib/gate.js', previousPath: null, status: 'modified', added: 1, removed: 1, binary: false, generated: false, truncated: false,
        absolutePath: '/w/hapigator-t1/lib/gate.js', firstLine: 2,
        diff: 'diff --git a/lib/gate.js b/lib/gate.js\n--- a/lib/gate.js\n+++ b/lib/gate.js\n@@ -1,2 +1,2 @@\n const a = 1\n-const b = 2\n+const b = 3',
      }],
    }],
  }
  const stored: Array<Record<string, unknown>> = []
  const calls: string[] = []
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push(`${method} ${url.replace(/^.*\/api/, '/api')}`)
    if (url.endsWith('/review-comments/send')) return Response.json(stored.map((item) => ({ ...item, status: 'sent' })))
    if (url.endsWith('/review-comments') && method === 'POST') {
      const body = JSON.parse(String(init!.body))
      const created = {
        id: 'r1', conversation_id: 'conversation-1', repository_label: body.repositoryLabel, worktree_path: body.worktreePath, path: body.path,
        side: body.side, start_line: body.startLine, end_line: body.endLine, line_text: body.lineText, body: body.body,
        status: 'draft', created_at: '2026-10-14T20:00:00Z', sent_at: null,
      }
      stored.push(created)
      return Response.json(created, { status: 201 })
    }
    if (url.endsWith('/review-comments')) return Response.json([])
    if (url.endsWith('/changes')) return Response.json(changes)
    return Response.json(data)
  }) as unknown as typeof fetch
  const sentToComposer: string[] = []

  render(createElement(ConversationWorkspaceCard, { projectId: 'p1', conversationId: 'conversation-1', onSendReview: (message: string) => sentToComposer.push(message) }))
  fireEvent.click(await screen.findByRole('button', { name: 'Voir les changements' }))
  await screen.findByText('1 fichier modifié')
  fireEvent.mouseOver(document.querySelector('.changes-diff-line[data-side="new"][data-line="2"]')!)
  expect(document.querySelectorAll('.changes-diff-comment-add')).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: 'Commenter la ligne 2' }))
  const field = screen.getByRole('textbox', { name: 'Commentaire, ligne 2' })
  fireEvent.change(field, { target: { value: 'Garde b à 2.' } })
  fireEvent.click(screen.getByRole('button', { name: 'Ajouter à la relecture' }))

  expect(await screen.findByText('Garde b à 2.')).toBeTruthy()
  expect(screen.getByText('Brouillon')).toBeTruthy()
  expect(stored[0]).toMatchObject({ path: 'lib/gate.js', side: 'new', start_line: 2, end_line: 2, line_text: 'const b = 3' })

  fireEvent.click(screen.getByRole('button', { name: 'Envoyer la relecture' }))
  expect(await screen.findByText('Envoyé')).toBeTruthy()
  expect(sentToComposer).toHaveLength(1)
  expect(sentToComposer[0]).toContain('1. `lib/gate.js:2` (hapigator)\n   > const b = 3\n   Garde b à 2.')
  expect(calls).toContain('POST /api/conversations/conversation-1/review-comments/send')
})

test('montre l’avancement des commentaires envoyés sous leurs lignes et dans l’en-tête du fichier', async () => {
  const data: CodeConversationCommits = {
    conversationId: 'conversation-1',
    total: 1,
    repositories: [{ repositoryPath: '/mono/apps/hapigator', repositoryLabel: 'apps/hapigator', commits: [commit('a', 'gate')] }],
    ticket: null,
  }
  const diff = 'diff --git a/lib/gate.js b/lib/gate.js\n--- a/lib/gate.js\n+++ b/lib/gate.js\n@@ -1,3 +1,3 @@\n const a = 1\n-const b = 2\n+const b = 3\n const c = 4'
  const changes = {
    truncated: false,
    repositories: [{
      repositoryLabel: 'hapigator', worktreePath: '/w/hapigator-t1', branch: 'feature/T-1', kind: 'commits', commits: 1, title: null,
      files: [{ path: 'lib/gate.js', previousPath: null, status: 'modified', added: 1, removed: 1, binary: false, generated: false, truncated: false, absolutePath: '/w/hapigator-t1/lib/gate.js', firstLine: 2, diff }],
    }],
  }
  const comment = (id: string, line: number, progress: string) => ({
    id, conversation_id: 'conversation-1', repository_label: 'hapigator', worktree_path: '/w/hapigator-t1', path: 'lib/gate.js', side: 'new',
    start_line: line, end_line: line, line_text: '', body: `Commentaire ${id}`, status: 'sent', created_at: '2026-10-14T20:00:00Z', sent_at: '2026-10-14T20:05:00Z', progress,
  })
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/review-comments')) return Response.json([comment('r1', 2, 'treated'), comment('r2', 3, 'pending')])
    if (url.endsWith('/changes')) return Response.json(changes)
    return Response.json(data)
  }) as unknown as typeof fetch

  render(createElement(ConversationWorkspaceCard, { projectId: 'p1', conversationId: 'conversation-1', onSendReview: () => {} }))
  fireEvent.click(await screen.findByRole('button', { name: 'Voir les changements' }))

  expect((await screen.findByText('1 traité · 1 en attente')).className).toContain('is-open')
  expect([...document.querySelectorAll('.review-note-status')].map((status) => [status.textContent, status.className.split(' ').at(-1)])).toEqual([
    ['Traité', 'is-treated'], ['En attente', 'is-pending'],
  ])
})
