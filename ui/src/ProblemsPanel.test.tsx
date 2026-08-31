import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { ProblemProjectPayload, Project, TicketRow } from './types'

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

const project = {
  id: 'p1', name: 'Pupitre', path: '/tmp/p1', permission_mode: null, filesystem_scope: 'project',
  pinned: false, created_at: '', default_preset_id: 'preset-1', auto_rescan: false,
} as unknown as Project

const preset = {
  id: 'preset-1', name: 'Fable', provider: 'claude', model: 'claude-fable-5', effort: 'high',
  speed: null, orchestrator: true, permission_mode: null, review_provider: 'claude',
  review_model: 'claude-fable-5', review_effort: 'high', built_in: false, created_at: '', updated_at: '',
}

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
    id: 'problem-3', public_id: 'PB-MATCH2', capture_id: 'capture-ok', project_id: 'p1',
    ticket_id: 't1', title: 'Mesurer la valeur créée', context: 'Le revenu reste inconnu.',
    resolution: 'Relier partenariats et chiffre.', plans: [
      { title: 'Attribuer', instruction: 'Relier la source.' },
      { title: 'Calculer', instruction: 'Calculer le revenu.' },
    ],
    status: 'open', closed_at: null, closed_commit_sha: null, conversation_count: 0,
    created_at: '2026-08-29T09:30:00Z', updated_at: '2026-08-29T09:30:00Z',
  }, {
    id: 'problem-2', public_id: 'PB-ABC123', capture_id: 'capture-old', project_id: 'p1',
    ticket_id: null, title: 'Ancienne problématique', context: 'Contexte clos.', resolution: 'Déjà fait.',
    plans: [{ title: 'Vérifier', instruction: 'Contrôler le résultat.' }], status: 'closed',
    closed_at: '2026-08-29T08:00:00Z', closed_commit_sha: 'abcdef123456', conversation_count: 1,
    created_at: '2026-08-28T09:00:00Z', updated_at: '2026-08-29T08:00:00Z',
  }],
}

test('affiche une seule action qui lance tous les axes de la problématique', () => {
  const onStartConversation = mock(() => {})
  render(createElement(ProblemsPanel, {
    project, payload, tickets: [ticket], onChanged: () => {}, onStartConversation, onConversationSelect: () => {},
  }))

  expect(screen.getByText('Traitement en échec')).toBeTruthy()
  expect(screen.getByText('sortie invalide')).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'Le bouton ne répond pas' })).toBeTruthy()
  expect(screen.getAllByText('TECH-42')).toHaveLength(2)
  expect(screen.getAllByRole('button', { name: 'Lancer tous les axes' })).toHaveLength(2)
  fireEvent.click(screen.getAllByRole('button', { name: 'Choisir le mode de lancement' })[0]!)
  fireEvent.click(screen.getByRole('menuitem', { name: /Ouvrir en conversation/ }))
  expect(onStartConversation).toHaveBeenCalledWith({
    problems: [expect.objectContaining({ public_id: 'PB-7K3M9Q' })],
    planIndices: { 'problem-1': [0] },
    missionTitle: 'Le bouton ne répond pas',
    mode: 'conversation',
  })
  expect(screen.queryByText('Ancienne problématique')).toBeNull()
})

test('regroupe manuellement plusieurs problématiques avec un titre modifiable', () => {
  const onStartConversation = mock(() => {})
  render(createElement(ProblemsPanel, {
    project, payload, tickets: [ticket], onChanged: () => {}, onStartConversation, onConversationSelect: () => {},
  }))

  fireEvent.click(screen.getByRole('checkbox', { name: 'Sélectionner PB-7K3M9Q' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Sélectionner PB-MATCH2' }))
  const title = screen.getByRole('textbox', { name: 'Titre de la mission' })
  fireEvent.change(title, { target: { value: 'Prouver Match AI' } })
  fireEvent.click(screen.getAllByRole('button', { name: 'Choisir le mode de lancement' })[0]!)
  fireEvent.click(screen.getByRole('menuitem', { name: /Ouvrir en conversation/ }))

  expect(onStartConversation).toHaveBeenCalledWith({
    problems: expect.arrayContaining([
      expect.objectContaining({ id: 'problem-1' }),
      expect.objectContaining({ id: 'problem-3' }),
    ]),
    planIndices: { 'problem-1': [0], 'problem-3': [0, 1] },
    missionTitle: 'Prouver Match AI',
    mode: 'conversation',
  })
})

test('filtre les problèmes fermés et expose le SHA de clôture', () => {
  render(createElement(ProblemsPanel, {
    project, payload, tickets: [ticket], onChanged: () => {}, onStartConversation: () => {}, onConversationSelect: () => {},
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
    project, payload, tickets: [ticket], onChanged: changed, onStartConversation: () => {}, onConversationSelect: () => {},
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

test('désélectionner un axe le retire de la mission et de son décompte', () => {
  const onStartConversation = mock(() => {})
  render(createElement(ProblemsPanel, {
    project, payload, tickets: [ticket], onChanged: () => {}, onStartConversation, onConversationSelect: () => {},
  }))

  expect(screen.getByText('2/2 axes')).toBeTruthy()
  fireEvent.click(screen.getByRole('checkbox', { name: 'Axe Attribuer de PB-MATCH2' }))

  expect(screen.getByText('1/2 axes')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Lancer 1 axe' })).toBeTruthy()
  fireEvent.click(screen.getAllByRole('button', { name: 'Choisir le mode de lancement' })[1]!)
  fireEvent.click(screen.getByRole('menuitem', { name: /Ouvrir en conversation/ }))

  expect(onStartConversation).toHaveBeenCalledWith({
    problems: [expect.objectContaining({ id: 'problem-3' })],
    planIndices: { 'problem-3': [1] },
    missionTitle: 'Mesurer la valeur créée',
    mode: 'conversation',
  })
})

test('le lancement agentique crée la conversation sur le preset par défaut et l’ouvre', async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = []
  globalThis.fetch = mock(async (input, init) => {
    const url = String(input)
    if (url === '/api/presets') return Response.json([preset])
    requests.push({ url, body: JSON.parse(String(init?.body ?? '{}')) })
    return Response.json({ id: 'conv-9' })
  }) as typeof fetch
  const opened = mock((_id: string) => {})
  render(createElement(ProblemsPanel, {
    project, payload, tickets: [ticket], onChanged: () => {}, onStartConversation: () => {}, onConversationSelect: opened,
  }))

  fireEvent.click(screen.getAllByRole('button', { name: 'Lancer tous les axes' })[0]!)

  await waitFor(() => expect(opened).toHaveBeenCalledWith('conv-9'))
  expect(requests[0]!.url).toBe('/api/conversations')
  expect(requests[0]!.body).toMatchObject({
    projectId: 'p1',
    presetId: 'preset-1',
    model: 'claude-fable-5',
    problemIds: ['problem-1'],
    problemPlanIndices: { 'problem-1': [0] },
    missionTitle: 'Le bouton ne répond pas',
  })
  expect(String(requests[0]!.body.message)).toContain('Corriger le bouton')
})
