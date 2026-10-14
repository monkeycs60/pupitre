import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { PushTimeline } = await import('./PushTimeline')
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
}, 30_000)

test('déplie le diff du push sous sa carte, fichier par fichier, puis le replie', async () => {
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/pushes') && !init?.method) return Response.json([
      { sha: 'aaaaaaaa', subject: 'premier', authoredAt: '', parent: 'parent', remoteUrl: null, repositoryPath: '/repo/hapigator' },
      { sha: 'bbbbbbbb', subject: 'second', authoredAt: '', parent: 'parent', remoteUrl: null, repositoryPath: '/repo/hapigator' },
    ])
    if (url.includes('/git/diff?')) return Response.json({
      diff: [
        'diff --git a/lib/a.js b/lib/a.js', '--- a/lib/a.js', '+++ b/lib/a.js', '@@ -1,2 +1,2 @@', ' const a = 1', '-const b = 2', '+const b = 3',
        'diff --git a/lib/new.js b/lib/new.js', 'new file mode 100644', '--- /dev/null', '+++ b/lib/new.js', '@@ -0,0 +1 @@', '+export {}',
      ].join('\n'),
    })
    return Response.json({ error: 'route inattendue' }, { status: 404 })
  }) as typeof fetch

  render(createElement(PushTimeline, { projectId: 'project-1', conversationId: 'conversation-1' }))
  fireEvent.click((await screen.findByText('premier')).closest('button')!)

  await screen.findByText('lib/new.js')
  const cards = [...document.querySelectorAll('.push-card')]
  const view = document.querySelector('.changes-view')!
  expect(cards[0]!.compareDocumentPosition(view) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(view.compareDocumentPosition(cards[1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect([...view.querySelectorAll('.changes-file-path')].map((path) => path.textContent)).toEqual(['lib/a.js', 'lib/new.js'])
  expect(view.querySelectorAll('.changes-diff-line.is-addition')).toHaveLength(2)

  fireEvent.click(screen.getByText('Masquer le diff').closest('button')!)
  expect(document.querySelector('.changes-view')).toBeNull()
}, 30_000)
