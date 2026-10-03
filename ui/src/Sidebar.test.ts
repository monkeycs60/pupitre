import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { Conversation, FleetItem, Project, Workflow } from './types'
import { formatActiveDuration } from './formatActiveDuration'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { Sidebar, chantierColor, compactGroupItems } = await import('./Sidebar')
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
  liveConversationMessageCount?: number,
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
    liveConversationMessageCount,
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

test('affiche le loading state et les réglages dans le détail d’une conversation', async () => {
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
  expect(screen.getByText('effort: high · vitesse: 1.5x')).toBeTruthy()
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

test('affiche le compteur live de la conversation sélectionnée', async () => {
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
  renderSidebar([activeItem], conversation, 4)

  await waitFor(() => expect(document.querySelector('.navigation-main')).not.toBeNull())
  expect(document.querySelector('.conv-row-count')?.textContent).toBe('4')
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
  expect(headers[0]).toBe('Sentry · REACTOR-B4S')
  expect(headers[1]).toBe("Aujourd'hui")
  expect(headers[2]).toBe('TECH-1')
  const ticketTitle = document.querySelector('.conv-group-ticket-title')
  expect(ticketTitle?.textContent).toBe('Corriger les pipelines de déploiement')
  expect(ticketTitle?.getAttribute('title')).toBe('Corriger les pipelines de déploiement')
  const ticketIcons = document.querySelector('.ticket-link-icons')
  expect(ticketIcons?.compareDocumentPosition(ticketTitle!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
  const ticketGroup = () => document.querySelectorAll('.conv-group')[2]!
  expect(ticketGroup().querySelectorAll('.navigation-row')).toHaveLength(1)
  expect(document.querySelector('.conv-group-more')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Afficher les 2 conversations de TECH-1' }))
  expect(ticketGroup().querySelectorAll('.navigation-row')).toHaveLength(2)
  expect(ticketGroup().querySelectorAll('.conv-row-ticket, .conv-row-ticket-title')).toHaveLength(0)
  expect(screen.getByRole('button', { name: 'Réduire TECH-1' }).getAttribute('aria-expanded')).toBe('true')
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

  const toggle = await screen.findByRole('button', { name: 'Récentes' })
  fireEvent.click(toggle)

  expect(toggle.getAttribute('aria-pressed')).toBe('true')
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
  expect(screen.getByText('1 à lire')).toBeTruthy()
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

test('replier un groupe cache ses conversations et garde le compte des non-lues', async () => {
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
  expect(screen.getByText('1 à lire')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Replier TECH-1' }))
  expect(document.querySelector('.navigation-row')).toBeNull()
  expect(screen.getByText('1 à lire')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Déplier TECH-1' }))
  expect(document.querySelector('.navigation-row')).not.toBeNull()
})

test('le menu du filtre bascule vers les archives', async () => {
  installApi([], () => Promise.reject(new Error('aucun lancement attendu')), [startedConversation])
  renderSidebar()

  await waitFor(() => expect(document.querySelector('.navigation-row')).not.toBeNull())
  fireEvent.click(screen.getByRole('button', { name: /Choisir le périmètre/ }))
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

test('les conversations récentes gardent le nom du ticket et la recherche accepte sa clé et son titre', async () => {
  const linked: Conversation = { ...startedConversation, id: 'ticket-search', title: 'Travail en cours', ticket_key: 'TECH-25267', ticket_title: 'Ciblage géographique', created_on_branch: 'feature/TECH-25267' }
  installApi([], () => Promise.reject(new Error('aucun lancement attendu')), [linked, { ...startedConversation, id: 'general', title: 'Autre travail' }])
  renderSidebar()
  await waitFor(() => expect(document.querySelectorAll('.navigation-row').length).toBe(2))
  fireEvent.click(screen.getByRole('button', { name: 'Récentes' }))
  expect(document.querySelector('.conv-row-ticket-title')?.textContent).toBe('Ciblage géographique')
  expect(document.querySelector('.conv-row-branch')?.textContent).toContain('feature/TECH-25267')
  fireEvent.change(screen.getByRole('textbox', { name: 'Filtrer les conversations' }), { target: { value: 'tech 25267 geographique' } })
  expect([...document.querySelectorAll('.conv-row-title')].map((item) => item.textContent)).toEqual(['Travail en cours'])
})

test('un groupe de ticket replié montre au plus trois conversations de moins de 24 h', () => {
  const now = Date.parse('2026-10-02T12:00:00.000Z')
  const at = (id: string, hoursAgo: number): Conversation => ({
    ...startedConversation,
    id,
    updated_at: new Date(now - hoursAgo * 3_600_000).toISOString(),
  })
  const ids = (items: Conversation[]) => items.map((item) => item.id)
  const busy = [at('a', 1), at('b', 2), at('c', 3), at('d', 4), at('e', 30)]
  expect(ids(compactGroupItems(busy, new Set(), now))).toEqual(['a', 'b', 'c'])
  expect(ids(compactGroupItems([at('a', 1), at('b', 30), at('c', 50)], new Set(), now))).toEqual(['a'])
  expect(ids(compactGroupItems([at('a', 30), at('b', 50)], new Set(), now))).toEqual(['a'])
  expect(ids(compactGroupItems(busy, new Set(['e']), now))).toEqual(['a', 'b', 'c', 'e'])
})

test('un groupe de ticket replié garde visible une conversation non lue de plus de 24 h', async () => {
  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString()
  const ticket = { ...startedConversation, ticket_id: 'ticket-9', ticket_key: 'TECH-9' }
  installApi([], () => Promise.reject(new Error('aucun lancement attendu')), [
    { ...ticket, id: 'recent-read', title: 'Récente lue', updated_at: hoursAgo(1) },
    { ...ticket, id: 'old-unread', title: 'Ancienne non lue', updated_at: hoursAgo(48), answered_turn: 3, last_read_turn: 1 },
    { ...ticket, id: 'old-read', title: 'Ancienne lue', updated_at: hoursAgo(72) },
  ])
  renderSidebar()

  await waitFor(() => expect(document.querySelectorAll('.conv-row-title')).toHaveLength(2))
  expect([...document.querySelectorAll('.conv-row-title')].map((element) => element.textContent)).toEqual(['Récente lue', 'Ancienne non lue'])
  expect(screen.getByRole('button', { name: 'Afficher les 3 conversations de TECH-9' }).getAttribute('title')).toBe('Afficher 1 de plus')
})

test('un chantier se présente par son nom, garde sa clé en retrait et se renomme depuis son en-tête', async () => {
  const chantier = { ...startedConversation, ticket_id: 'chantier-9', ticket_key: 'CH-9', ticket_title: 'Setup, déploiement et configuration utilisateur' }
  installApi([], () => Promise.reject(new Error('aucun lancement attendu')), [
    { ...chantier, id: 'c1', title: 'Préparer Pupitre pour macOS' },
    { ...chantier, id: 'c2', title: 'Désinstaller claude-notifications', answered_turn: 3, last_read_turn: 1 },
  ])
  const requests: Array<{ url: string; method?: string; body?: unknown }> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/chantiers/')) {
      requests.push({ url, method: init?.method, body: JSON.parse(String(init?.body)) })
      return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } })
    }
    return originalFetch(input, init)
  }) as unknown as typeof fetch
  try {
    renderSidebar()
    await waitFor(() => expect(document.querySelector('.conv-group-header.is-chantier')).not.toBeNull())
    const header = document.querySelector('.conv-group-header.is-chantier')!
    expect(header.querySelector('.conv-group-key')?.textContent).toBe('Setup, déploiement et configuration utilisateur')
    expect(header.querySelector('.conv-group-chantier-key')?.textContent).toBe('CH-9')
    expect(header.querySelector('.conv-chantier-dot')).not.toBeNull()
    expect(header.querySelector('.conv-group-count.is-attention')).toBeNull()
    expect(header.querySelector('.conv-group-unread-dot')?.getAttribute('aria-label')).toBe('1 à lire')
    expect(document.querySelectorAll('.conv-row-ticket, .conv-row-ticket-title')).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: 'Actions pour le chantier Setup, déploiement et configuration utilisateur' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Renommer le chantier' }))
    const input = screen.getByRole('textbox', { name: /Nouveau nom pour le chantier/ })
    fireEvent.change(input, { target: { value: 'Installation Pupitre sur macOS' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(header.querySelector('.conv-group-key')?.textContent).toBe('Installation Pupitre sur macOS'))
    expect(requests).toEqual([expect.objectContaining({ method: 'PUT', body: { title: 'Installation Pupitre sur macOS' } })])
    expect(requests[0]!.url).toContain('/chantiers/chantier-9')

    fireEvent.click(screen.getByRole('button', { name: 'Récentes' }))
    await waitFor(() => expect(document.querySelectorAll('.conv-row-ticket-title .conv-chantier-dot')).toHaveLength(2))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('deux chantiers consécutifs reçoivent deux couleurs différentes', () => {
  const colors = ['CH-1', 'CH-2', 'CH-3', 'CH-4', 'CH-5', 'CH-6', 'CH-7', 'CH-8'].map(chantierColor)
  expect(new Set(colors).size).toBe(8)
  expect(chantierColor('CH-9')).toBe(chantierColor('CH-1'))
})
