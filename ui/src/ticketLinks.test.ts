import { expect, test } from 'bun:test'
import { gitlabContextOf, mergeRequestSearchUrl, ticketLinksIndex, ticketLinksOf } from './ticketLinks'
import type { DashboardPayload, TicketRow } from './types'

const ticket = {
  id: 't1',
  key: 'TECH-24128',
  external_url: 'https://app.clickup.com/t/x',
  refs: [
    { id: 'r1', ticket_id: 't1', kind: 'branch', ref: 'feature/TECH-24128', payload: {}, seen_at: '' },
    { id: 'r2', ticket_id: 't1', kind: 'mr', ref: 'hapigator!473', payload: { url: 'https://git.kaizen-hosting.com/Affilae/hapigator/-/merge_requests/473' }, seen_at: '' },
  ],
} as unknown as TicketRow

const payload = {
  tickets: [ticket],
  integrations: [{ id: 'i1', type: 'gitlab', status: 'ok', last_ok_at: null, last_error: null, branch_pattern: null, config: { host: 'https://git.kaizen-hosting.com/' } }],
  gitlabUsername: 'clement.serizay',
} as unknown as DashboardPayload

test('vise la recherche du tableau GitLab, pas la MR d’un seul dépôt', () => {
  const links = ticketLinksOf(ticket, gitlabContextOf(payload))
  expect(links.mergeRequestUrl).toBe(
    'https://git.kaizen-hosting.com/dashboard/merge_requests/search?scope=all&state=opened&assignee_username=clement.serizay&search=24128',
  )
})

test('sans hôte GitLab connu, la MR relevée reste la destination', () => {
  const links = ticketLinksOf(ticket, { host: null, username: null })
  expect(links.mergeRequestUrl).toBe('https://git.kaizen-hosting.com/Affilae/hapigator/-/merge_requests/473')
})

test('sans pseudo, la recherche porte le seul numéro de ticket', () => {
  expect(mergeRequestSearchUrl('TECH-24128', { host: 'https://git.kaizen-hosting.com', username: null }))
    .toBe('https://git.kaizen-hosting.com/dashboard/merge_requests/search?scope=all&state=opened&search=24128')
})

test('l’index sert le même lien par clé et par id', () => {
  const index = ticketLinksIndex(payload)
  expect(index.get('TECH-24128')).toEqual(index.get('t1')!)
  expect(index.get('t1')!.mergeRequestUrl).toContain('/dashboard/merge_requests/search?')
})
