import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { SentryInboxPayload } from './types'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { SentryInbox } = await import('./SentryInbox')
const defaultFetch = globalThis.fetch

const issue = {
  id: 'local-1', integration_id: 'sentry-1', project_id: 'p1', sentry_issue_id: '42',
  payload: {
    shortId: 'HAPI-42', project: 'hapigator', title: 'Matching search timed out',
    transaction: 'POST /matching/search', level: 'error', count: 6, userCount: 5,
    permalink: 'https://sentry.io/issues/42',
  },
  relevance: { matched: true, reasons: [{ domain: 'Match AI', signal: 'matching' }] },
  lifecycle: 'active' as const,
  first_seen_at: '2026-08-21T10:00:00Z', last_seen_at: '2026-08-21T11:00:00Z',
  last_scanned_at: '2026-08-21T11:00:00Z',
}

const inbox: SentryInboxPayload = {
  projectId: 'p1', issues: [issue],
  integration: { status: 'ok', lastOkAt: '2026-08-21T11:00:00Z', lastError: null, tokenConfigured: true },
}

afterEach(() => {
  cleanup()
  globalThis.fetch = defaultFetch
})

function mount() {
  render(createElement(SentryInbox, {
    projectId: 'p1',
    onConversationSelect: () => {},
  }))
}

test('attend la fin réelle du scan puis affiche son bilan', async () => {
  let finishScan!: () => void
  const scanGate = new Promise<void>((resolve) => { finishScan = resolve })
  const refreshed = { ...inbox, integration: { ...inbox.integration!, lastOkAt: '2026-08-21T12:34:00Z' } }
  globalThis.fetch = mock(async (input, init) => {
    const url = String(input)
    if (init?.method === 'POST' && url.includes('/sentry/refresh')) {
      await scanGate
      return Response.json(refreshed)
    }
    return Response.json(inbox)
  }) as typeof fetch
  mount()

  const button = await screen.findByRole('button', { name: 'Scanner maintenant' })
  fireEvent.click(button)
  expect((await screen.findByRole('button', { name: 'Scan en cours…' }) as HTMLButtonElement).disabled).toBe(true)

  finishScan()
  expect(await screen.findByText(/Scan terminé · 1 issue · 12:34/)).toBeTruthy()
})

test('ouvre un dialogue centré opaque selon le pattern commun', async () => {
  globalThis.fetch = mock(async (input) => Response.json(
    String(input).includes('/api/sentry/issues/') ? issue : inbox,
  )) as typeof fetch
  mount()

  fireEvent.click(await screen.findByRole('button', { name: /Matching search timed out/ }))
  const dialog = await screen.findByRole('dialog', { name: 'Matching search timed out' })

  expect(dialog.classList.contains('review-dialog')).toBe(true)
  expect(dialog.classList.contains('sentry-detail')).toBe(true)
    expect(screen.getAllByRole('button', { name: 'Fermer' })).toHaveLength(2)
})

test('affiche une erreur de scan sans perdre les issues existantes', async () => {
  globalThis.fetch = mock(async (input, init) => (
    init?.method === 'POST'
      ? Response.json({ error: 'Sentry indisponible' }, { status: 503 })
      : Response.json(String(input).includes('/api/sentry/issues/') ? issue : inbox)
  )) as typeof fetch
  mount()

  fireEvent.click(await screen.findByRole('button', { name: 'Scanner maintenant' }))

  expect((await screen.findByRole('alert')).textContent).toContain('Scan impossible : Sentry indisponible')
  await waitFor(() => expect(screen.getByRole('button', { name: /Matching search timed out/ })).toBeTruthy())
})
