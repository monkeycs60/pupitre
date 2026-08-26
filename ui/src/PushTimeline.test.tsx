import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { PushTimeline } = await import('./PushTimeline')
const defaultFetch = globalThis.fetch

afterEach(() => {
  cleanup()
  globalThis.fetch = defaultFetch
})

test('acquitte puis masque un push sans toucher aux autres', async () => {
  const calls: string[] = []
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push(`${init?.method ?? 'GET'} ${url}`)
    if (url.endsWith('/pushes') && !init?.method) return Response.json([
      { sha: 'aaaaaaaa', subject: 'premier', authoredAt: '', parent: 'parent', remoteUrl: null, repositoryPath: '/repo' },
      { sha: 'bbbbbbbb', subject: 'second', authoredAt: '', parent: 'parent', remoteUrl: null, repositoryPath: '/repo' },
    ])
    if (url.endsWith('/pushes/aaaaaaaa/ack') && init?.method === 'POST') return Response.json({ ok: true })
    return Response.json({ error: 'route inattendue' }, { status: 404 })
  }) as typeof fetch

  render(createElement(PushTimeline, { projectId: 'project-1', conversationId: 'conversation-1' }))
  await screen.findByText('premier')
  fireEvent.click(screen.getByRole('button', { name: 'Acquitter le push premier' }))

  await waitFor(() => expect(screen.queryByText('premier')).toBeNull())
  expect(screen.getByText('second')).toBeTruthy()
  expect(calls.some((call) => call.includes('POST') && call.endsWith('/pushes/aaaaaaaa/ack'))).toBe(true)
}, 10_000)
