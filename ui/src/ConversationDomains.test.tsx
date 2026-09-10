import { afterEach, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { ConversationDomains } from './ConversationDomains'
import type { Conversation, ProjectDomain } from './types'

const domain: ProjectDomain = {
  id: 'domain-match',
  project_id: 'project-1',
  name: 'Match AI',
  kind: 'métier',
  status: 'actif',
  created_at: '2026-09-11T00:00:00.000Z',
  updated_at: '2026-09-11T00:00:00.000Z',
}

const conversation = {
  id: 'conversation-1',
  project_id: 'project-1',
  domains: [],
} as unknown as Conversation

const originalFetch = globalThis.fetch

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

test('ajoute un domaine depuis l’en-tête de la conversation', async () => {
  globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === '/api/projects/project-1/domains') {
      return Promise.resolve(Response.json([domain]))
    }
    if (String(input) === '/api/conversations/conversation-1/domains' && init?.method === 'POST') {
      return Promise.resolve(Response.json({ ...conversation, domains: [{ id: domain.id, name: domain.name, kind: domain.kind }] }))
    }
    return Promise.reject(new Error(`Requête inattendue : ${String(input)}`))
  }) as typeof fetch
  const onChange = mock(() => undefined)

  render(createElement(ConversationDomains, { conversation, onChange }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Modifier les domaines' })).not.toBeNull())
  fireEvent.click(screen.getByRole('button', { name: 'Modifier les domaines' }))
  fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Match AI' }))

  await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1))
  expect(onChange.mock.calls[0]?.[0].domains[0].name).toBe('Match AI')
})
