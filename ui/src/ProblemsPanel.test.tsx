import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { ProblemProjectPayload, TicketRow } from './types'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { ProblemsPanel } = await import('./ProblemsPanel')
const defaultFetch = globalThis.fetch
const defaultConfirm = window.confirm

afterEach(() => {
  cleanup()
  globalThis.fetch = defaultFetch
  window.confirm = defaultConfirm
})

const ticket = {
  id: 't1', project_id: 'p1', key: 'TECH-42', source: 'clickup', title: 'Bouton', status: 'todo',
  external_url: 'https://app.clickup.com/t/TECH-42', instruction: '', payload: {}, last_seen_at: '',
  archived_at: null, created_at: '', updated_at: '', refs: [], conversations: [], notes_count: 0,
} as TicketRow

const payload: ProblemProjectPayload = {
  projectId: 'p1',
  captures: [{
    id: 'capture-1', project_id: 'p1', raw_text: 'texte brut', status: 'error',
    error: 'sortie invalide', created_at: '2026-08-29T10:00:00Z', updated_at: '2026-08-29T10:01:00Z',
  }],
  problems: [{
    id: 'problem-1', public_id: 'PB-7K3M9Q', capture_id: 'capture-ok', project_id: 'p1',
    ticket_id: 't1', title: 'Le bouton ne répond pas', context: 'Le clic reste sans effet.',
    resolution: 'Restaurer le gestionnaire.', plans: [{ title: 'Corriger le bouton', instruction: 'Reproduire puis corriger.' }],
    status: 'open', closed_at: null, closed_commit_sha: null, conversation_count: 0,
    created_at: '2026-08-29T09:00:00Z', updated_at: '2026-08-29T09:00:00Z',
  }, {
    id: 'problem-2', public_id: 'PB-ABC123', capture_id: 'capture-old', project_id: 'p1',
    ticket_id: null, title: 'Ancienne problématique', context: 'Contexte clos.', resolution: 'Déjà fait.',
    plans: [{ title: 'Vérifier', instruction: 'Contrôler le résultat.' }], status: 'closed',
    closed_at: '2026-08-29T08:00:00Z', closed_commit_sha: 'abcdef123456', conversation_count: 1,
    created_at: '2026-08-28T09:00:00Z', updated_at: '2026-08-29T08:00:00Z',
  }],
}

test('affiche les captures en erreur et les problématiques ouvertes avec leur plan', () => {
  render(createElement(ProblemsPanel, {
    payload, tickets: [ticket], onChanged: () => {}, onStartConversation: () => {},
  }))

  expect(screen.getByText('Traitement en échec')).toBeTruthy()
  expect(screen.getByText('sortie invalide')).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'Le bouton ne répond pas' })).toBeTruthy()
  expect(screen.getByText('TECH-42')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Lancer Corriger le bouton' })).toBeTruthy()
  expect(screen.queryByText('Ancienne problématique')).toBeNull()
})

test('filtre les problèmes fermés et expose le SHA de clôture', () => {
  render(createElement(ProblemsPanel, {
    payload, tickets: [ticket], onChanged: () => {}, onStartConversation: () => {},
  }))

  fireEvent.click(screen.getByRole('button', { name: 'Fermées' }))

  expect(screen.getByRole('heading', { name: 'Ancienne problématique' })).toBeTruthy()
  expect(screen.getByText('abcdef1')).toBeTruthy()
  expect(screen.queryByText('Le bouton ne répond pas')).toBeNull()
})

test('relance, ferme, corrige le ticket et supprime avec confirmation', async () => {
  const requests: Array<{ url: string; method: string }> = []
  globalThis.fetch = mock(async (input, init) => {
    requests.push({ url: String(input), method: init?.method ?? 'GET' })
    return init?.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json({})
  }) as typeof fetch
  window.confirm = () => true
  const changed = mock(() => {})
  render(createElement(ProblemsPanel, {
    payload, tickets: [ticket], onChanged: changed, onStartConversation: () => {},
  }))

  fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }))
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(1))
  fireEvent.change(screen.getByLabelText('Ticket de PB-7K3M9Q'), { target: { value: '' } })
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(2))
  fireEvent.click(screen.getByRole('button', { name: 'Fermer PB-7K3M9Q' }))
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(3))
  fireEvent.click(screen.getByRole('button', { name: 'Supprimer PB-7K3M9Q' }))

  await waitFor(() => expect(changed).toHaveBeenCalledTimes(4))
  expect(requests).toEqual(expect.arrayContaining([
    { url: '/api/problem-captures/capture-1/retry', method: 'POST' },
    { url: '/api/problems/problem-1/ticket', method: 'PUT' },
    { url: '/api/problems/problem-1/close', method: 'POST' },
    { url: '/api/problems/problem-1', method: 'DELETE' },
  ]))
})
