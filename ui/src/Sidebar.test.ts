import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { Conversation, Project, Workflow } from './types'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { Sidebar } = await import('./Sidebar')

const project: Project = {
  id: 'pupitre',
  name: 'Pupitre',
  path: '/workspace/pupitre',
  permission_mode: 'default',
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
  orchestrator: true,
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
  permission_mode: 'default',
  orchestrator: true,
  subagent_preset_id: null,
  subagent_effort: null,
  continued_from: null,
  routine_id: null,
  cli_session_id: null,
  pinned: false,
  title_locked: false,
  digest_turn: 0,
  archived: false,
  deleted_at: null,
  created_at: '2026-08-08T09:00:00.000Z',
  updated_at: '2026-08-08T09:00:00.000Z',
}

const defaultFetch = globalThis.fetch

afterEach(() => {
  cleanup()
  globalThis.fetch = defaultFetch
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
) {
  let runRequestCount = 0
  const fetchMock = mock((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = String(input)
    if (path === `/api/projects/${project.id}/conversations?scope=active`) {
      return Promise.resolve(jsonResponse([]))
    }
    if (path === `/api/projects/${project.id}/workflows`) {
      return Promise.resolve(jsonResponse(workflows))
    }
    const match = path.match(/^\/api\/workflows\/([^/]+)\/run$/)
    if (match && init?.method === 'POST') {
      runRequestCount += 1
      return runRequest(decodeURIComponent(match[1]!))
    }
    return Promise.reject(new Error(`Requête inattendue : ${path}`))
  })
  globalThis.fetch = fetchMock as typeof fetch
  return {
    getRunRequestCount: () => runRequestCount,
  }
}

function renderSidebar() {
  const onConversationSelect = mock(() => undefined)
  render(createElement(Sidebar, {
    selectedProject: project,
    selectedConversation: null,
    onProjectSelect: () => undefined,
    onConversationSelect,
    onConversationCreate: () => undefined,
    conversationListVersion: 0,
    quotas: { snapshot: { claude: null, codex: null } },
    runningSubtasks: 0,
    workspaceView: 'conversations',
    onProgressSelect: () => undefined,
    gamification: null,
    xpPulse: null,
  }))
  return onConversationSelect
}

async function openWorkflows() {
  const workflowsTab = await screen.findByRole('tab', { name: /Workflows [1-9]/ })
  fireEvent.click(workflowsTab)
}

test('sélectionne la conversation créée après le lancement réussi d’un workflow', async () => {
  installApi([reviewWorkflow], () => Promise.resolve(jsonResponse(startedConversation)))
  const onConversationSelect = renderSidebar()
  await openWorkflows()

  fireEvent.click(screen.getByRole('button', { name: 'Lancer →' }))

  await waitFor(() => {
    expect(onConversationSelect).toHaveBeenCalledWith(startedConversation)
  })
  expect(screen.getByRole('tab', { name: /Conversations/ }).getAttribute('aria-selected'))
    .toBe('true')
})

test('affiche le rejet du lancement sans sélectionner de conversation', async () => {
  installApi([reviewWorkflow], () => Promise.resolve(jsonResponse(
    { error: 'Lancement impossible' },
    500,
  )))
  const onConversationSelect = renderSidebar()
  await openWorkflows()

  const runButton = screen.getByRole('button', { name: 'Lancer →' }) as HTMLButtonElement
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
  const onConversationSelect = renderSidebar()
  await openWorkflows()

  fireEvent.click(screen.getAllByRole('button', { name: 'Lancer →' })[0]!)
  const otherRunButton = await screen.findByRole('button', { name: 'Lancer →' }) as HTMLButtonElement

  expect(screen.getByRole('button', { name: 'Lancement…' })).toBeTruthy()
  expect(otherRunButton.disabled).toBe(true)
  fireEvent.click(otherRunButton)
  expect(api.getRunRequestCount()).toBe(1)

  resolveRunRequest?.(jsonResponse(startedConversation))
  await waitFor(() => {
    expect(onConversationSelect).toHaveBeenCalledWith(startedConversation)
  })
})
