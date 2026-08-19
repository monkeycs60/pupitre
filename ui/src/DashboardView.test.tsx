import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { DashboardPayload, Project } from './types'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const { DashboardView } = await import('./DashboardView')

const defaultFetch = globalThis.fetch
const DefaultSocket = globalThis.WebSocket

class SilentSocket {
  constructor(public url: string) {}

  addEventListener() {}

  close() {}
}

afterEach(() => {
  cleanup()
  globalThis.fetch = defaultFetch
  globalThis.WebSocket = DefaultSocket
})

const project = {
  id: 'p1',
  name: 'affilae-mono',
  path: '/tmp/mono',
} as Project

const ticket = {
  id: 't1',
  project_id: 'p1',
  key: 'TECH-24657',
  source: 'clickup',
  title: 'Leviers',
  status: 'in progress',
  external_url: 'https://app.clickup.com/t/x',
  payload: { statusColor: '#4466ff' },
  last_seen_at: '',
  archived_at: null,
  created_at: '',
  updated_at: '2026-08-19T10:00:00Z',
  notes_count: 0,
  refs: [
    { id: 'r1', ticket_id: 't1', kind: 'branch', ref: 'feature/TECH-24657', payload: {}, seen_at: '' },
    { id: 'r2', ticket_id: 't1', kind: 'mr', ref: 'reactor!1862', payload: { url: 'https://git/1862', mergeStatus: 'mergeable', state: 'opened' }, seen_at: '' },
    { id: 'r3', ticket_id: 't1', kind: 'pipeline', ref: 'reactor!1862', payload: { status: 'failed', url: 'https://git/p' }, seen_at: '' },
  ],
  conversations: [{ id: 'c1', title: 'Première passe', summary: '', provider: 'claude', updated_at: '', worktree_path: '/wt' }],
}

const withGitlab: DashboardPayload = {
  projectId: 'p1',
  refreshedAt: '',
  integrations: [{
    id: 'i1',
    type: 'gitlab',
    config: {},
    branch_pattern: null,
    status: 'dégradée',
    last_ok_at: null,
    last_error: 'fetch failed',
  }],
  tickets: [ticket],
  environments: [{
    project: 'reactor',
    name: 'preprod',
    branch: 'feature/TECH-23903',
    key: 'TECH-23903',
    mergeRequestIid: 1815,
    user: 'theo.micaletti',
    deployedAt: '2026-08-18T08:44:45Z',
    status: 'success',
    jobUrl: null,
  }],
  toReview: [],
}

function mount(payload: DashboardPayload, onStart = mock(() => {})) {
  globalThis.fetch = mock(async () => Response.json(payload)) as typeof fetch
  globalThis.WebSocket = SilentSocket as unknown as typeof WebSocket
  render(createElement(DashboardView, {
    project,
    onConversationSelect: () => {},
    onStartConversation: onStart,
  }))
  return onStart
}

test('rend une ligne par ticket, la colonne Déployé avec GitLab, et le bandeau de dégradation', async () => {
  mount(withGitlab)

  await screen.findByText('TECH-24657')

  expect(document.querySelectorAll('.dashboard-row:not(.dashboard-head)')).toHaveLength(1)
  expect(document.querySelector('.dashboard-table--with-gitlab')).not.toBeNull()
  expect(screen.getByText(/GitLab/).textContent).toContain('dégradée')
  expect(screen.getByText('failed')).toBeTruthy()
  expect(screen.getByText('preprod')).toBeTruthy()
})

test('Reprendre transmet ticket et branche ; sans GitLab la colonne Déployé disparaît', async () => {
  const onStart = mount({ ...withGitlab, integrations: [], environments: [] })

  const button = await screen.findByRole('button', { name: 'Reprendre' })
  fireEvent.click(button)

  expect(onStart).toHaveBeenCalledWith({
    ticketId: 't1',
    branch: 'feature/TECH-24657',
    ticketKey: 'TECH-24657',
  })
  expect(document.querySelector('.dashboard-table--with-gitlab')).toBeNull()
})

test('un ticket sans conversation propose Démarrer', async () => {
  mount({ ...withGitlab, tickets: [{ ...ticket, conversations: [] }] })

  expect(await screen.findByRole('button', { name: 'Démarrer' })).toBeTruthy()
})
