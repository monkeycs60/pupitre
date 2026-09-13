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

test('résume les commits de la conversation par dépôt et ouvre l’onglet Code', async () => {
  const data: CodeConversationCommits = {
    conversationId: 'conversation-1',
    total: 3,
    repositories: [
      { repositoryPath: '/mono/apps/hapigator', repositoryLabel: 'apps/hapigator', commits: [commit('a', 'gate adaptative'), commit('b', 'quota')] },
      { repositoryPath: '/mono/apps/reactor', repositoryLabel: 'apps/reactor', commits: [commit('c', 'drawer')] },
    ],
  }
  globalThis.fetch = mock(async () => Response.json(data)) as unknown as typeof fetch
  const onOpenCode = mock(() => {})

  render(createElement(ConversationWorkspaceCard, { projectId: 'p1', conversationId: 'conversation-1', onOpenCode }))

  expect(await screen.findByText('3 commits sur 2 dépôts')).toBeTruthy()
  expect([...document.querySelectorAll('.code-workspace-card-repos .code-repo-badge')].map((badge) => badge.textContent)).toEqual(['hapigator', 'reactor'])
  expect(screen.getByText('gate adaptative')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Voir dans Code' }))
  expect(onOpenCode).toHaveBeenCalledWith('conversation-1')
})

test('reste invisible tant que la conversation n’a rien commité', async () => {
  globalThis.fetch = mock(async () => Response.json({ conversationId: 'c', total: 0, repositories: [] })) as unknown as typeof fetch
  const { container } = render(createElement(ConversationWorkspaceCard, { projectId: 'p1', conversationId: 'c' }))
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(container.innerHTML).toBe('')
})
