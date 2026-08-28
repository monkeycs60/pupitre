import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import type { DashboardPayload, Project } from './types'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { DashboardView } = await import('./DashboardView')
const dashboardCss = readFileSync(new URL('./styles/dashboard.css', import.meta.url), 'utf8')

const defaultFetch = globalThis.fetch
const DefaultSocket = globalThis.WebSocket

class SilentSocket {
  constructor(public url: string) {}

  addEventListener() {}

  close() {}
}

afterEach(() => {
  cleanup()
  window.localStorage.clear()
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
  instruction: 'Vérifier la rétrocompatibilité.',
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
  globalThis.fetch = mock(async (input) => (
    String(input).includes('/notes') ? Response.json([]) : Response.json(payload)
  )) as typeof fetch
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
  expect(screen.getByText('Échec')).toBeTruthy()
  expect(screen.getByText('Fusionnable')).toBeTruthy()
  fireEvent.click(screen.getByRole('tab', { name: 'Environnements' }))
  expect(screen.getByText('preprod')).toBeTruthy()
})

test('sépare le tableau en cinq onglets et mémorise le dernier onglet du projet', async () => {
  mount(withGitlab)

  await screen.findByText('TECH-24657')
  const tabs = screen.getAllByRole('tab')
  expect(tabs.map((tab) => tab.textContent)).toEqual([
    'Mes tickets',
    'Problématiques',
    'Issues Sentry',
    'Changelog',
    'Environnements',
  ])
  expect(screen.getByRole('tab', { name: 'Mes tickets' }).getAttribute('aria-selected')).toBe('true')
  expect(screen.queryByRole('heading', { name: 'Environnements' })).toBeNull()

  fireEvent.keyDown(screen.getByRole('tab', { name: 'Mes tickets' }), { key: 'ArrowRight' })
  expect(screen.getByRole('tab', { name: 'Problématiques' }).getAttribute('aria-selected')).toBe('true')
  expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Problématiques' }))

  fireEvent.click(screen.getByRole('tab', { name: 'Environnements' }))

  expect(await screen.findByRole('heading', { name: 'Environnements' })).toBeTruthy()
  expect(screen.queryByText('TECH-24657')).toBeNull()
  expect(window.localStorage.getItem('pupitre:dashboard-tab:p1')).toBe('environments')

  cleanup()
  mount(withGitlab)

  expect(await screen.findByRole('heading', { name: 'Environnements' })).toBeTruthy()
  expect(screen.getByRole('tab', { name: 'Environnements' }).getAttribute('aria-selected')).toBe('true')
})

test('capture un collage avec Ctrl Entrée puis ouvre les problématiques', async () => {
  mount(withGitlab)
  fireEvent.click(await screen.findByRole('button', { name: 'Capturer' }))
  const textarea = screen.getByRole('textbox', { name: 'Texte à structurer' })
  expect(textarea.getAttribute('maxlength')).toBe('50000')
  fireEvent.change(textarea, { target: { value: 'deux sujets collés' } })
  fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true })

  expect(window.localStorage.getItem('pupitre:dashboard-tab:p1')).toBe('problems')
  expect(globalThis.fetch).toHaveBeenCalledWith(
    '/api/projects/p1/problem-captures',
    expect.objectContaining({ method: 'POST', body: JSON.stringify({ text: 'deux sujets collés' }) }),
  )
})

test('Nouvelle conv. transmet ticket et branche ; sans GitLab la colonne Déployé disparaît', async () => {
  const onStart = mount({ ...withGitlab, integrations: [], environments: [] })

  const button = await screen.findByRole('button', { name: 'Nouvelle conv.' })
  fireEvent.click(button)

  expect(onStart).toHaveBeenCalledWith({
    ticketId: 't1',
    branch: 'feature/TECH-24657',
    ticketKey: 'TECH-24657',
  })
  expect(document.querySelector('.dashboard-table--with-gitlab')).toBeNull()
})

test('un ticket sans conversation propose aussi Nouvelle conv.', async () => {
  mount({ ...withGitlab, tickets: [{ ...ticket, conversations: [] }] })

  expect(await screen.findByRole('button', { name: 'Nouvelle conv.' })).toBeTruthy()
})

test('rend les liens ClickUp et MR explicites dans les cellules concernées', async () => {
  mount(withGitlab)

  await screen.findByText('TECH-24657')

  const clickUpLink = screen.getByRole('link', { name: 'Ouvrir TECH-24657 dans ClickUp' })
  expect(clickUpLink.getAttribute('href')).toBe('https://app.clickup.com/t/x')
  expect(clickUpLink.parentElement?.classList.contains('dashboard-ticket-heading')).toBe(true)

  const mergeRequestLink = screen.getByRole('link', { name: /MR reactor!1862/ })
  expect(mergeRequestLink.getAttribute('href')).toBe('https://git/1862')
  expect(screen.queryByRole('link', { name: 'Ouvrir' })).toBeNull()
})

test('sépare les pastilles des cellules statut et branche et garde les colonnes scrollables', async () => {
  mount(withGitlab)

  await screen.findByText('TECH-24657')

  const statusCell = document.querySelector('.dashboard-status')
  const branchCell = document.querySelector('.dashboard-branch')
  expect(statusCell?.querySelector('.dashboard-status-dot')).not.toBeNull()
  expect(branchCell?.classList.contains('dashboard-status-dot')).toBe(false)

  expect(dashboardCss).toMatch(/\.dashboard-status,\s*\.dashboard-branch\s*\{[\s\S]*?display:\s*inline-flex/)
  expect(dashboardCss).toMatch(/\.dashboard-status-dot\s*\{[\s\S]*?width:\s*8px;[\s\S]*?height:\s*8px;/)
  expect(dashboardCss).toMatch(/\.dashboard-scroll\s*\{[\s\S]*?overflow-x:\s*auto;[\s\S]*?overflow-y:\s*auto/)
  expect(dashboardCss).toMatch(/\.dashboard-table\s*\{[\s\S]*?overflow:\s*visible/)
})

test('expose les conversations et édite l’instruction dans un dialogue centré', async () => {
  mount(withGitlab)

  await screen.findByText('TECH-24657')

  const conversationsButton = screen.getByRole('button', { name: 'Conversations (1)' })
  expect(conversationsButton.getAttribute('aria-expanded')).toBe('false')
  expect(conversationsButton.getAttribute('aria-controls')).toBe('ticket-t1-conversations')

  fireEvent.click(conversationsButton)

  expect(conversationsButton.getAttribute('aria-expanded')).toBe('true')
  expect(document.getElementById('ticket-t1-conversations')).not.toBeNull()

  fireEvent.click(screen.getByRole('button', { name: 'Instruction' }))
  expect(screen.getByRole('dialog', { name: 'Instruction · TECH-24657' })).toBeTruthy()
  expect((screen.getByLabelText('Instruction') as HTMLTextAreaElement).value).toBe('Vérifier la rétrocompatibilité.')
})

test('trie les tickets par statut puis inverse le tri', async () => {
  mount({ ...withGitlab, tickets: [ticket, { ...ticket, id: 't2', key: 'TECH-3', status: 'Open' }] })
  await screen.findByText('TECH-24657')

  const statusSort = screen.getByRole('button', { name: /Statut/ })
  fireEvent.click(statusSort)
  expect([...document.querySelectorAll('.dashboard-key')].map((item) => item.textContent)).toEqual(['TECH-24657', 'TECH-3'])
  fireEvent.click(statusSort)
  expect([...document.querySelectorAll('.dashboard-key')].map((item) => item.textContent)).toEqual(['TECH-3', 'TECH-24657'])
})

test('traduit et colore les états GitLab ambigus', async () => {
  const unchecked = {
    ...ticket,
    id: 'unchecked',
    key: 'TECH-1',
    refs: ticket.refs.map((ref) => ref.kind === 'mr'
      ? { ...ref, id: 'mr-unchecked', payload: { ...ref.payload, mergeStatus: 'unchecked' } }
      : ref),
  }
  const conflict = {
    ...ticket,
    id: 'conflict',
    key: 'TECH-2',
    refs: ticket.refs.map((ref) => ref.kind === 'mr'
      ? { ...ref, id: 'mr-conflict', payload: { ...ref.payload, mergeStatus: 'conflict', hasConflicts: true } }
      : ref),
  }
  mount({ ...withGitlab, tickets: [unchecked, conflict] })

  const waiting = await screen.findByText('Vérification en attente')
  const conflicts = screen.getByText('Conflits')
  expect(waiting.classList.contains('is-neutral')).toBe(true)
  expect(waiting.getAttribute('title')).toContain('pas encore calculé')
  expect(conflicts.classList.contains('is-danger')).toBe(true)
  expect(screen.getAllByText('Échec').every((item) => item.classList.contains('is-danger'))).toBe(true)
})

test('affiche le changelog compact, son échéance au survol et permet une actualisation manuelle', async () => {
  const nextRefresh = new Date(Date.now() + 90 * 60_000).toISOString()
  const refreshRequests: string[] = []
  globalThis.fetch = mock(async (input) => {
    const url = String(input)
    if (url.endsWith('/changelog/refresh')) {
      refreshRequests.push(url)
      return Response.json({
        project_id: 'p1', status: 'running', last_started_at: new Date().toISOString(),
        last_refreshed_at: null, next_refresh_at: nextRefresh, error: null,
      }, { status: 202 })
    }
    if (url.endsWith('/changelog')) {
      return Response.json({
        entries: [{
          project_id: 'p1', repository_path: '.', commit_sha: 'e8ac32b123456789', branch: 'main',
          subject: 'feat: show undated contact events', committed_at: '2026-08-27T10:00:00Z',
          domain_id: 'contacts', domain_name: 'Contacts',
          product_message: 'Les événements sans date apparaissent dans la fiche contact.',
          enrichment_status: 'enriched', imported_at: '2026-08-27T10:01:00Z', enriched_at: '2026-08-27T10:02:00Z',
        }, {
          project_id: 'p1', repository_path: 'apps/reactor', commit_sha: 'd887678123456789', branch: 'feature/TECH-24128',
          subject: 'fix: type suppressed source errors', committed_at: '2026-08-26T18:31:00Z',
          domain_id: null, domain_name: null, product_message: null,
          enrichment_status: 'pending', imported_at: '2026-08-27T10:01:00Z', enriched_at: null,
        }],
        state: {
          project_id: 'p1', status: 'idle', last_started_at: '2026-08-27T10:00:00Z',
          last_refreshed_at: '2026-08-27T10:02:00Z', next_refresh_at: nextRefresh, error: null,
        },
      })
    }
    return Response.json(withGitlab)
  }) as typeof fetch
  globalThis.WebSocket = SilentSocket as unknown as typeof WebSocket
  render(createElement(DashboardView, {
    project,
    onConversationSelect: () => {},
    onStartConversation: () => {},
  }))

  fireEvent.click(screen.getByRole('tab', { name: 'Changelog' }))
  expect(await screen.findByText('Les événements sans date apparaissent dans la fiche contact.')).toBeTruthy()
  expect(screen.getByText('feat: show undated contact events')).toBeTruthy()
  expect(screen.getByText('main')).toBeTruthy()
  expect(screen.getByText('e8ac32b')).toBeTruthy()
  expect(screen.getByText('reactor')).toBeTruthy()

  const menuButton = screen.getByRole('button', { name: /Changelog/ })
  expect(menuButton.getAttribute('title')).toContain('Prochaine actualisation dans')
  fireEvent.click(menuButton)
  fireEvent.click(screen.getByRole('menuitem', { name: 'Actualiser le changelog' }))

  await waitFor(() => expect(refreshRequests).toHaveLength(1))
})
