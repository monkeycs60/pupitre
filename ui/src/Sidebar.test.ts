import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { Conversation, FleetItem, Project, Workflow } from './types'
import { formatActiveDuration } from './formatActiveDuration'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { Sidebar, compactGroupItems, workBranchLabel } = await import('./Sidebar')
const { WorkflowsView } = await import('./WorkflowsView')

const project: Project = {
  id: 'pupitre',
  name: 'Pupitre',
  path: '/workspace/pupitre',
  permission_mode: 'acceptEdits',
  filesystem_scope: 'project-and-ai-roots',
  pinned: false,
  created_at: '2026-08-08T08:00:00.000Z',
  default_preset_id: null,
  auto_counter_red: false,
  auto_rescan: false,
}

const reviewWorkflow: Workflow = {
  id: 'review',
  project_id: project.id,
  name: 'Revue de PR',
  skill_id: 'skill-review',
  skill_name: 'Diff review',
  skill_invocation: 'diff-review',
  prompt: 'Relis le diff de la branche courante.',
  preset_id: 'builtin-quality',
  provider: 'codex',
  model: 'gpt-5.6-sol',
  effort: 'high',
  speed: 'standard',
  created_at: '2026-08-08T08:00:00.000Z',
  updated_at: '2026-08-08T08:00:00.000Z',
}

const releaseWorkflow: Workflow = {
  ...reviewWorkflow,
  id: 'release',
  name: 'Préparer la release',
  skill_id: 'skill-release',
  skill_name: 'Release prep',
  skill_invocation: 'release-prep',
  prompt: 'Prépare les notes de version.',
}

const startedConversation: Conversation = {
  id: 'conversation-from-workflow',
  project_id: project.id,
  title: 'Revue de PR',
  summary: '',
  provider: 'codex',
  model: 'gpt-5.6-sol',
  effort: 'high',
  speed: 'standard',
  permission_mode: 'acceptEdits',
  continued_from: null,
  routine_id: null,
  worktree_path: null,
  created_on_branch: null,
  ticket_id: null,
  cli_session_id: null,
  pinned: false,
  title_locked: false,
  digest_turn: 0,
  answered_turn: 0,
  archived: false,
  deleted_at: null,
  created_at: '2026-08-08T09:00:00.000Z',
  updated_at: '2026-08-08T09:00:00.000Z',
}

const defaultFetch = globalThis.fetch

afterEach(() => {
  cleanup()
  globalThis.fetch = defaultFetch
  localStorage.clear()
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function installApi(
  workflows: Workflow[],
  runRequest: (workflowId: string) => Promise<Response>,
  conversations: Conversation[] = [],
) {
  let runRequestCount = 0
  let readRequestCount = 0
  const fetchMock = mock((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = String(input)
    const method = init?.method ?? 'GET'
    if (path === `/api/projects/${project.id}/conversations?scope=active`) {
      return Promise.resolve(jsonResponse(conversations))
    }
    if (path === `/api/projects/${project.id}/workflows`) {
      return Promise.resolve(jsonResponse(workflows))
    }
    const readMatch = path.match(/^\/api\/conversations\/([^/]+)\/read$/)
    if (readMatch && init?.method === 'POST') {
      readRequestCount += 1
      return Promise.resolve(jsonResponse(conversations.find((item) => item.id === decodeURIComponent(readMatch[1]!)) ?? conversations[0] ?? startedConversation))
    }
    const match = path.match(/^\/api\/workflows\/([^/]+)\/run$/)
    if (match && init?.method === 'POST') {
      runRequestCount += 1
      return runRequest(decodeURIComponent(match[1]!))
    }
    return Promise.reject(new Error(`Requête inattendue : ${method} ${path}`))
  })
  globalThis.fetch = fetchMock as typeof fetch
  return {
    getRunRequestCount: () => runRequestCount,
    getReadRequestCount: () => readRequestCount,
  }
}

function renderSidebar(
  activeFleet: FleetItem[] = [],
  selectedConversation: Conversation | null = null,
  _unused?: number,
  onConversationCreateFromContext?: (seed: { branch: string | null; originType?: 'sentry' | null; originKey?: string | null }) => void,
  ticketLinks?: Map<string, { ticketKey: string; externalUrl: string | null; mergeRequestUrl: string | null; branch: string | null }>,
) {
  const onConversationSelect = mock(() => undefined)
  render(createElement(Sidebar, {
    selectedProject: project,
    selectedConversation,
    onProjectSelect: () => undefined,
    onConversationSelect,
    onConversationCreate: () => undefined,
    onConversationCreateFromContext,
    conversationListVersion: 0,
    runningSubtasks: 0,
    activeFleet,
    workspaceView: 'conversations',
    ticketLinks,
  }))
  return onConversationSelect
}

function renderWorkflows() {
  const onConversationSelect = mock(() => undefined)
  render(createElement(WorkflowsView, { project, onConversationSelect }))
  return onConversationSelect
}
async function openWorkflows() {
  await screen.findAllByRole('button', { name: 'Lancer' })
}

test('sélectionne la conversation créée après le lancement réussi d’un workflow', async () => {
  installApi([reviewWorkflow], () => Promise.resolve(jsonResponse(startedConversation)))
  const onConversationSelect = renderWorkflows()
  await openWorkflows()

  fireEvent.click(screen.getByRole('button', { name: 'Lancer' }))

  await waitFor(() => {
    expect(onConversationSelect).toHaveBeenCalledWith(startedConversation)
  })
})

test('affiche le rejet du lancement sans sélectionner de conversation', async () => {
  installApi([reviewWorkflow], () => Promise.resolve(jsonResponse(
    { error: 'Lancement impossible' },
    500,
  )))
  const onConversationSelect = renderWorkflows()
  await openWorkflows()

  const runButton = screen.getByRole('button', { name: 'Lancer' }) as HTMLButtonElement
  fireEvent.click(runButton)

  expect((await screen.findByRole('alert')).textContent).toBe('Lancement impossible')
  expect(onConversationSelect).toHaveBeenCalledTimes(0)
  expect(runButton.disabled).toBe(false)
})

test('empêche un second lancement tant que le premier workflow est en cours', async () => {
  let resolveRunRequest: ((response: Response) => void) | undefined
  const pendingRunRequest = new Promise<Response>((resolve) => {
    resolveRunRequest = resolve
  })
  const api = installApi(
    [reviewWorkflow, releaseWorkflow],
    () => pendingRunRequest,
  )
  const onConversationSelect = renderWorkflows()
  await openWorkflows()

  fireEvent.click(screen.getAllByRole('button', { name: 'Lancer' })[0]!)
  const otherRunButton = await screen.findByRole('button', { name: 'Lancer' }) as HTMLButtonElement

  expect(screen.getByRole('button', { name: 'Lancement…' })).toBeTruthy()
  expect(otherRunButton.disabled).toBe(true)
  fireEvent.click(otherRunButton)
  expect(api.getRunRequestCount()).toBe(1)

  resolveRunRequest?.(jsonResponse(startedConversation))
  await waitFor(() => {
    expect(onConversationSelect).toHaveBeenCalledWith(startedConversation)
  })
})

test('formate les durées actives longues en heures et minutes', () => {
  expect(formatActiveDuration(68 * 60_000)).toBe('1 h 08')
})

test('affiche le loading state sans infobulle de détail sur la conversation', async () => {
  const conversation: Conversation = {
    ...startedConversation,
    id: 'conversation-live',
    title: 'Panel Documents redimensionnable',
    summary: 'Aperçu de la conversation',
    speed: 'fast',
    updated_at: '2026-08-08T09:05:00.000Z',
  }
  const activeItem: FleetItem = {
    id: 'turn-live',
    kind: 'turn',
    projectId: project.id,
    projectName: project.name,
    conversationId: conversation.id,
    title: conversation.title,
    provider: conversation.provider,
    model: conversation.model,
    startedAt: '2026-08-08T09:05:00.000Z',
    lastEvent: 'outil · lecture',
  }
  installApi([], () => Promise.reject(new Error('aucun lancement attendu')), [conversation])
  renderSidebar([activeItem])

  expect(await screen.findByText('écrit la réponse')).toBeTruthy()
  expect(document.querySelectorAll('.conv-row-dots i')).toHaveLength(3)
  expect(screen.queryByText('appelle un outil')).toBeNull()
  expect(screen.queryByRole('tooltip')).toBeNull()
  expect(screen.queryByText('Aperçu de la conversation')).toBeNull()
})

test('marque comme lue la conversation ouverte quand la sidebar recharge sa liste', async () => {
  const conversation: Conversation = {
    ...startedConversation,
    id: 'conversation-open',
    title: 'Conversation ouverte',
    answered_turn: 4,
    last_read_turn: 2,
  }
  const api = installApi([], () => Promise.reject(new Error('aucun lancement attendu')), [conversation])
  renderSidebar([], conversation)

  await waitFor(() => expect(document.querySelector('.navigation-main')).not.toBeNull())
  const row = document.querySelector('.navigation-main')?.closest('.navigation-row')
  expect(row?.className).toContain('conv-row-state-read')
  await waitFor(() => expect(api.getReadRequestCount()).toBe(1))
})

test('une conversation en cours passe dans « En cours » avec son action du moment', async () => {
  const conversation: Conversation = {
    ...startedConversation,
    id: 'conversation-live-count',
    title: 'Conversation live',
    message_count: 2,
  }
  const activeItem: FleetItem = {
    id: 'turn-live-count',
    kind: 'turn',
    projectId: project.id,
    projectName: project.name,
    conversationId: conversation.id,
    title: conversation.title,
    provider: conversation.provider,
    model: conversation.model,
    startedAt: '2026-08-08T09:05:00.000Z',
    lastEvent: 'outil · lecture',
  }
  installApi([], () => Promise.reject(new Error('aucun lancement attendu')), [conversation])
  renderSidebar([activeItem], conversation)

  await waitFor(() => expect(document.querySelector('.navigation-main')).not.toBeNull())
  expect(document.querySelector('.conv-group-key')?.textContent).toBe('En cours')
  expect(document.querySelector('.conv-group-count.is-live')?.textContent).toBe('1')
  expect(document.querySelector('.conv-row-line2.is-live .conv-row-activity-label')?.textContent).toBe('écrit la réponse')
})

test('place les groupes ticket et Sentry selon leur dernière activité', async () => {
  const todayAtNine = new Date()
  todayAtNine.setHours(9, 0, 0, 0)
  const ticketYesterday: Conversation = {
    ...startedConversation,
    id: 'conversation-ticket-1',
    title: 'Ticket hier',
    ticket_id: 'ticket-1',
    ticket_key: 'TECH-1',
    worktree_path: '/workspace/pupitre/.worktrees/feature/TECH-1',
    updated_at: '2026-08-18T09:00:00.000Z',
  }
  const ticketToday: Conversation = {
    ...startedConversation,
    id: 'conversation-ticket-2',
    title: 'Ticket aujourd’hui',
    ticket_id: 'ticket-1',
    ticket_key: 'TECH-1',
    worktree_path: '/workspace/pupitre/.worktrees/feature/TECH-1-fix',
    updated_at: '2026-08-19T09:00:00.000Z',
  }
  const recentUnticketed: Conversation = {
    ...startedConversation,
    id: 'conversation-no-ticket',
    title: 'Sans ticket',
    updated_at: todayAtNine.toISOString(),
  }
  const sentryConversation: Conversation = {
    ...startedConversation,
    id: 'conversation-sentry',
    title: 'Scout erreur',
    origin_type: 'sentry',
    origin_key: 'REACTOR-B4S',
    worktree_path: '/worktrees/detached-sentry-REACTOR-B4S',
    updated_at: new Date(todayAtNine.getTime() + 60_000).toISOString(),
  }
  installApi(
    [],
    () => Promise.reject(new Error('aucun lancement attendu')),
    [ticketYesterday, ticketToday, recentUnticketed, sentryConversation],
  )
  const onCreate = mock(() => undefined)
  renderSidebar([], null, undefined, onCreate, new Map([['TECH-1', {
    ticketKey: 'TECH-1',
    title: 'TECH-1 — Corriger les pipelines de déploiement',
    externalUrl: null,
    mergeRequestUrl: null,
    branch: 'feature/TECH-1',
  }]]))

  await waitFor(() => expect(document.querySelectorAll('.conv-group-header').length).toBe(3))
  const headers = [...document.querySelectorAll('.conv-group-key')].map((element) => element.textContent)
  expect(headers).toEqual(['Sentry · REACTOR-B4S', 'TECH-1', 'Sans ticket'])
  const ticketTitle = document.querySelector('.conv-group-ticket-title')
  expect(ticketTitle?.textContent).toBe('Corriger les pipelines de déploiement')
  expect(ticketTitle?.getAttribute('title')).toBe('Corriger les pipelines de déploiement')
  const ticketIcons = document.querySelector('.conv-group.is-context .ticket-link-icons')
  expect(ticketTitle?.compareDocumentPosition(ticketIcons!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
  const ticketGroup = () => document.querySelectorAll('.conv-group')[1]!
  expect(ticketGroup().querySelectorAll('.navigation-row')).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: '1 autre' }))
  expect(ticketGroup().querySelectorAll('.navigation-row')).toHaveLength(2)
  expect(ticketGroup().querySelectorAll('.conv-row-ticket')).toHaveLength(0)
  expect(screen.getByRole('button', { name: 'Réduire' }).getAttribute('aria-expanded')).toBe('true')
  expect(document.querySelector('.conv-row-sentry .provider-mark.is-sentry')).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /Nouvelle conversation dans Sentry/ }))
  expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
    branch: null,
    originType: 'sentry',
    originKey: 'REACTOR-B4S',
  }))
  fireEvent.click(screen.getByRole('button', { name: 'Nouvelle conversation dans TECH-1' }))
  expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
    ticketId: 'ticket-1',
    ticketKey: 'TECH-1',
    branch: 'feature/TECH-1',
  }))
})

test('affiche toutes les conversations dans un flux strictement récent', async () => {
  const oldest: Conversation = {
    ...startedConversation,
    id: 'conversation-oldest',
    title: 'Ancienne sans ticket',
    updated_at: '2026-08-17T09:00:00.000Z',
  }
  const newestTicket: Conversation = {
    ...startedConversation,
    id: 'conversation-newest',
    title: 'Dernière sur ticket',
    ticket_id: 'ticket-9',
    ticket_key: 'TECH-9',
    updated_at: '2026-08-19T11:00:00.000Z',
  }
  const middleSentry: Conversation = {
    ...startedConversation,
    id: 'conversation-middle',
    title: 'Sentry intermédiaire',
    origin_type: 'sentry',
    origin_key: 'APP-42',
    updated_at: '2026-08-18T10:00:00.000Z',
  }
  installApi([], () => Promise.reject(new Error('aucun lancement attendu')), [oldest, newestTicket, middleSentry])
  renderSidebar()

  fireEvent.click(await screen.findByRole('button', { name: /Périmètre et tri/ }))
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Par activité récente' }))

  expect([...document.querySelectorAll('.conv-group-key')].map((element) => element.textContent)).toEqual(['Récentes'])
  expect([...document.querySelectorAll('.conv-row-title')].map((element) => element.textContent)).toEqual([
    'Dernière sur ticket',
    'Sentry intermédiaire',
    'Ancienne sans ticket',
  ])
  expect(localStorage.getItem('pupitre:conversation-sort')).toBe('recent')
})

test('un tour qui quitte le flottant fait apparaître la conversation à lire', async () => {
  const conversation: Conversation = {
    ...startedConversation,
    id: 'conversation-en-fond',
    title: 'Conversation en fond',
    answered_turn: 0,
    last_read_turn: 0,
  }
  const listed: Conversation[] = [conversation]
  const activeItem: FleetItem = {
    id: 'turn-en-fond',
    kind: 'turn',
    projectId: project.id,
    projectName: project.name,
    conversationId: conversation.id,
    title: conversation.title,
    provider: conversation.provider,
    model: conversation.model,
    startedAt: '2026-08-08T09:05:00.000Z',
    lastEvent: 'outil · lecture',
  }
  installApi([], () => Promise.reject(new Error('aucun lancement attendu')), listed)
  const props = {
    selectedProject: project,
    selectedConversation: null,
    onProjectSelect: () => undefined,
    onConversationSelect: () => undefined,
    onConversationCreate: () => undefined,
    conversationListVersion: 0,
    runningSubtasks: 0,
    workspaceView: 'conversations' as const,
  }
  const { rerender } = render(createElement(Sidebar, { ...props, activeFleet: [activeItem] }))

  await waitFor(() => {
    expect(document.querySelector('.navigation-row')?.className).toContain('conv-row-state-live')
  })

  // Le tour se termine : le sidecar a écrit `answered_turn` avant de retirer
  // l'entrée du flottant.
  listed[0] = { ...conversation, answered_turn: 1 }
  rerender(createElement(Sidebar, { ...props, activeFleet: [] }))

  await waitFor(() => {
    expect(document.querySelector('.navigation-row')?.className).toContain('conv-row-state-unread')
  })
  expect(document.querySelector('.conv-group-key')?.textContent).toBe('À toi')
  expect(document.querySelector('.conv-row-line2.is-unread')?.textContent).toContain('Réponse à lire')
})

test('revenir sur un projet rouvre sa dernière conversation', async () => {
  const conversation: Conversation = {
    ...startedConversation,
    id: 'conversation-reprise',
    title: 'Conversation à reprendre',
  }
  localStorage.setItem('pupitre:last-conversation:pupitre', conversation.id)
  installApi([], () => Promise.reject(new Error('aucun lancement attendu')), [conversation])
  const onConversationSelect = renderSidebar()

  await waitFor(() => expect(onConversationSelect).toHaveBeenCalledTimes(1))
  expect((onConversationSelect.mock.calls[0] as unknown as [Conversation])[0].id).toBe(conversation.id)
})

test('aucune reprise quand la dernière conversation a quitté la liste active', async () => {
  const conversation: Conversation = {
    ...startedConversation,
    id: 'conversation-presente',
    title: 'Toujours là',
  }
  localStorage.setItem('pupitre:last-conversation:pupitre', 'conversation-archivee')
  installApi([], () => Promise.reject(new Error('aucun lancement attendu')), [conversation])
  const onConversationSelect = renderSidebar()

  await waitFor(() => expect(document.querySelector('.navigation-row')).not.toBeNull())
  expect(onConversationSelect).toHaveBeenCalledTimes(0)
})

test('une réponse non lue passe dans « À toi » et replier le groupe garde son compte', async () => {
  const unreadTicket: Conversation = {
    ...startedConversation,
    id: 'conversation-unread-ticket',
    title: 'Ticket non lu',
    ticket_id: 'ticket-1',
    ticket_key: 'TECH-1',
    answered_turn: 3,
    last_read_turn: 1,
  }
  installApi([], () => Promise.reject(new Error('aucun lancement attendu')), [unreadTicket])
  renderSidebar()

  await waitFor(() => expect(document.querySelector('.navigation-row')).not.toBeNull())
  expect(document.querySelector('.conv-group-key')?.textContent).toBe('À toi')
  expect(document.querySelector('.conv-row-line2.is-unread')?.textContent).toBe('Réponse à lireTECH-1')
  fireEvent.click(screen.getByRole('button', { name: 'Replier À toi' }))
  expect(document.querySelector('.navigation-row')).toBeNull()
  expect(document.querySelector('.conv-group-count.is-waiting')?.textContent).toBe('1')
  fireEvent.click(screen.getByRole('button', { name: 'Déplier À toi' }))
  expect(document.querySelector('.navigation-row')).not.toBeNull()
})

test('le menu du filtre bascule vers les archives', async () => {
  installApi([], () => Promise.reject(new Error('aucun lancement attendu')), [startedConversation])
  renderSidebar()

  await waitFor(() => expect(document.querySelector('.navigation-row')).not.toBeNull())
  fireEvent.click(screen.getByRole('button', { name: /Périmètre et tri/ }))
  expect(screen.getByRole('menuitemradio', { name: 'Actives' }).getAttribute('aria-checked')).toBe('true')
  expect(screen.getByRole('menuitemradio', { name: 'Corbeille' })).toBeTruthy()
})

test('ouvrir une conversation depuis ailleurs déplie son groupe et l’amène dans la vue', async () => {
  const ticketConversation: Conversation = {
    ...startedConversation,
    id: 'conversation-in-ticket',
    title: 'Depuis le rapport',
    ticket_id: 'ticket-9',
    ticket_key: 'TECH-9',
  }
  const scrolled: string[] = []
  const original = Element.prototype.scrollIntoView
  Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this.getAttribute('data-conversation-id') ?? '') }
  try {
    localStorage.setItem(`pupitre:sidebar-collapsed:${project.id}`, JSON.stringify(['ticket-TECH-9']))
    installApi([], () => Promise.reject(new Error('aucun lancement attendu')), [ticketConversation])
    renderSidebar([], ticketConversation)
    await waitFor(() => expect(document.querySelector('[data-conversation-id="conversation-in-ticket"]')).not.toBeNull())
    await waitFor(() => expect(scrolled).toEqual(['conversation-in-ticket']))
    expect(screen.getByRole('button', { name: 'Replier TECH-9' })).toBeTruthy()
  } finally {
    Element.prototype.scrollIntoView = original
    localStorage.removeItem(`pupitre:sidebar-collapsed:${project.id}`)
  }
})

test('les conversations récentes gardent la clé du ticket et la recherche accepte sa clé et son titre', async () => {
  const now = new Date().toISOString()
  const linked: Conversation = { ...startedConversation, id: 'ticket-search', title: 'Travail en cours', ticket_key: 'TECH-25267', ticket_title: 'Ciblage géographique', created_on_branch: 'feature/TECH-25267', updated_at: now }
  installApi([], () => Promise.reject(new Error('aucun lancement attendu')), [linked, { ...startedConversation, id: 'general', title: 'Autre travail', updated_at: now }])
  renderSidebar()
  await waitFor(() => expect(document.querySelectorAll('.navigation-row').length).toBe(2))
  fireEvent.click(screen.getByRole('button', { name: /Périmètre et tri/ }))
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Par activité récente' }))
  expect(document.querySelector('.conv-row-ticket')?.textContent).toBe('TECH-25267')
  expect(document.querySelector('.conv-row-branch')?.textContent).toContain('feature/TECH-25267')
  fireEvent.change(screen.getByRole('textbox', { name: /Filtrer les conversations/ }), { target: { value: 'tech 25267 geographique' } })
  expect([...document.querySelectorAll('.conv-row-title')].map((item) => item.textContent)).toEqual(['Travail en cours'])
})

test('un groupe de ticket replié montre au plus deux conversations de moins de 24 h', () => {
  const now = Date.parse('2026-10-02T12:00:00.000Z')
  const at = (id: string, hoursAgo: number): Conversation => ({
    ...startedConversation,
    id,
    updated_at: new Date(now - hoursAgo * 3_600_000).toISOString(),
  })
  const ids = (items: Conversation[]) => items.map((item) => item.id)
  const busy = [at('a', 1), at('b', 2), at('c', 3), at('d', 4), at('e', 30)]
  expect(ids(compactGroupItems(busy, new Set(), now))).toEqual(['a', 'b'])
  expect(ids(compactGroupItems([at('a', 1), at('b', 30), at('c', 50)], new Set(), now))).toEqual(['a'])
  expect(ids(compactGroupItems([at('a', 30), at('b', 50)], new Set(), now))).toEqual(['a'])
  expect(ids(compactGroupItems(busy, new Set(['e']), now))).toEqual(['a', 'b', 'e'])
})

test('une conversation non lue ancienne remonte dans « À toi » au-dessus de son ticket', async () => {
  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString()
  const ticket = { ...startedConversation, ticket_id: 'ticket-9', ticket_key: 'TECH-9' }
  installApi([], () => Promise.reject(new Error('aucun lancement attendu')), [
    { ...ticket, id: 'recent-read', title: 'Récente lue', updated_at: hoursAgo(1) },
    { ...ticket, id: 'old-unread', title: 'Ancienne non lue', updated_at: hoursAgo(48), answered_turn: 3, last_read_turn: 1 },
    { ...ticket, id: 'old-read', title: 'Ancienne lue', updated_at: hoursAgo(72) },
  ])
  renderSidebar()

  await waitFor(() => expect(document.querySelectorAll('.conv-row-title')).toHaveLength(2))
  expect([...document.querySelectorAll('.conv-group-key')].map((element) => element.textContent)).toEqual(['À toi', 'TECH-9'])
  expect([...document.querySelectorAll('.conv-row-title')].map((element) => element.textContent)).toEqual(['Ancienne non lue', 'Récente lue'])
  expect(screen.getByRole('button', { name: '1 autre' })).toBeTruthy()
})

test('raccourcit une clé de ticket à son numéro, sans toucher aux autres libellés', async () => {
  const { shortTicketKey } = await import('./Sidebar')
  expect(shortTicketKey('TECH-25064')).toBe('25064')
  expect(shortTicketKey('Cette semaine')).toBe('Cette semaine')
  expect(shortTicketKey('CH-1')).toBe('1')
})

test('le tronc n’est jamais affiché comme branche de travail, une branche de travail l’est', () => {
  const base = { ...startedConversation, worktree_path: null, worktree_paths: [], created_on_branch: null }
  expect(workBranchLabel({ ...base, created_on_branch: 'main' }, null)).toBeNull()
  expect(workBranchLabel({ ...base, created_on_branch: 'origin/master' }, null)).toBeNull()
  expect(workBranchLabel({ ...base, created_on_branch: 'trunk' }, null, 'trunk')).toBeNull()
  expect(workBranchLabel({ ...base, created_on_branch: 'feature/agenda' }, null)).toEqual({ label: 'feature/agenda', title: 'Branche à la création' })
  expect(workBranchLabel({ ...base, worktree_path: '/w/a', worktree_paths: ['/w/a', '/w/b'] }, 'fix/dictee')).toEqual({ label: 'fix/dictee +1', title: 'Worktrees : /w/a, /w/b' })
  expect(workBranchLabel({ ...base, worktree_path: '/w/a' }, 'develop')).toBeNull()
})

test('le provider s’affiche sur la première ligne et la seconde n’existe que pour une branche de travail', async () => {
  const now = new Date().toISOString()
  installApi([], () => Promise.reject(new Error('aucun lancement attendu')), [
    { ...startedConversation, id: 'trunk', title: 'Sur le tronc', created_on_branch: 'main', worktree_path: null, updated_at: now },
    { ...startedConversation, id: 'work', title: 'Sur une branche', created_on_branch: 'feature/agenda', worktree_path: null, updated_at: now },
  ])
  renderSidebar()
  await waitFor(() => expect(document.querySelectorAll('.conv-row-title')).toHaveLength(2))
  const row = (id: string) => document.querySelector(`[data-conversation-id="${id}"]`)!
  expect(row('trunk').querySelector('.conv-row-line1 .conv-row-mark')).not.toBeNull()
  expect(row('trunk').querySelector('.conv-row-line2')).toBeNull()
  expect(row('work').querySelector('.conv-row-line2')?.textContent).toBe('feature/agenda')
})
