import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { Project } from './types'

if (typeof document === 'undefined') GlobalRegistrator.register()
const { cleanup, render, screen, fireEvent, waitFor } = await import('@testing-library/react')
const { SharedFilesView } = await import('./SharedFilesView')
const originalFetch = globalThis.fetch
const project = { id: 'p1' } as Project

afterEach(() => { cleanup(); globalThis.fetch = originalFetch })

test('charge la conversation puis le projet et retrouve le message d’origine', async () => {
  const requests: string[] = []
  globalThis.fetch = mock(async (url: string) => {
    requests.push(url)
    return Response.json([{ id: 'media:a.png', name: 'a.png', kind: 'image', sizeBytes: 3, mimeType: 'image/png', mediaName: 'a.png', document: null,
      origins: [{ conversationId: 'c1', conversationTitle: 'Mon audit', eventId: 42, sender: 'assistant', createdAt: '2026-09-07T12:00:00Z' }] }])
  }) as unknown as typeof fetch
  const select = mock(() => {})
  render(createElement(SharedFilesView, { currentProject: project, conversationId: 'c1', onConversationSelect: select }))
  await screen.findByText('a.png')
  expect(requests[0]).toContain('projectId=p1&conversationId=c1')
  fireEvent.change(screen.getByLabelText('Portée des fichiers'), { target: { value: 'project' } })
  await waitFor(() => expect(requests.at(-1)).toBe('/api/shared-files?projectId=p1'))
  await screen.findByText('a.png')
  fireEvent.click(screen.getByText(/Mon audit/))
  expect(select).toHaveBeenCalledWith('p1', 'c1', 42)
  fireEvent.change(screen.getByLabelText('Rechercher un fichier'), { target: { value: 'inconnu' } })
  expect(screen.getByText('Aucun fichier ne correspond à la recherche.')).toBeTruthy()
})

test('ne charge aucun fichier sans projet', () => {
  const fetchMock = mock(async () => Response.json([]))
  globalThis.fetch = fetchMock as unknown as typeof fetch
  render(createElement(SharedFilesView, { currentProject: null, conversationId: null, onConversationSelect: () => {} }))
  expect(fetchMock).not.toHaveBeenCalled()
  expect(screen.getByText(/Sélectionnez un projet/)).toBeTruthy()
})
