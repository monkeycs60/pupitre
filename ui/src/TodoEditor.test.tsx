import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { Project, QuotaSnapshot } from './types'
import type { TodoInput, TodoItem } from './todos'

if (typeof document === 'undefined') GlobalRegistrator.register()
const { act, cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { TodoEditor } = await import('./TodoEditor')
const { TodoDetail } = await import('./TodoDetail')
const originalFetch = globalThis.fetch

const project: Project = {
  id: 'project-tasks', name: 'Personnel', path: '/tmp/personnel', permission_mode: 'acceptEdits',
  filesystem_scope: 'project-and-ai-roots', pinned: false, created_at: '2026-09-12T00:00:00Z',
  default_todo_preset_id: 'todo-preset', auto_counter_red: false, auto_rescan: false,
}
const quotas: QuotaSnapshot = { claude: null, codex: null, grok: null }
const task: TodoItem = {
  id: 'task-1', project_id: project.id, title: 'Réparer le raccourci', message: 'Réparer le raccourci',
  ticket_id: null, target_branch: null, integrate: false, autonomy: 'local', depends_on: null,
  status: 'backlog', conversation_id: null, branch: null, worktree_path: null, error: null,
  position: 0, created_at: '2026-09-12T00:00:00Z', updated_at: '2026-09-12T00:00:00Z',
  provider: 'codex', model: 'gpt-5.6-sol', effort: 'low', attachments: [], checks: [],
}
const requests: { path: string; method: string; body: Record<string, unknown> | undefined }[] = []

beforeEach(() => {
  requests.length = 0
  globalThis.fetch = mock((input: string | URL, init?: RequestInit) => {
    const path = String(input)
    requests.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (path.endsWith('/git')) return Promise.resolve(new Response(JSON.stringify({ error: 'Pas un dépôt Git' }), { status: 400 }))
    const body = path.endsWith('/presets')
      ? [{ id: 'todo-preset', name: 'Tâches', provider: 'codex', model: 'gpt-5.6-sol', effort: 'low', speed: 'standard', permission_mode: null, orchestrator: true, subagent_preset_id: null, subagent_effort: null }]
      : path.endsWith('/dashboard')
        ? { tickets: [{ id: 'ticket-42', key: 'TECH-42', title: 'Raccourci', links: {} }] }
        : task
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }))
  }) as typeof fetch
})

afterEach(() => { cleanup(); globalThis.fetch = originalFetch })

test('un titre suffit pour créer une tâche sans Git avec le preset projet chargé dans les options repliées', async () => {
  const created = mock(() => {})
  const { container } = render(createElement(TodoEditor, { project, items: [], quotas, compact: true, onCreated: created, onCancel: () => {} }))
  const title = screen.getByRole('textbox', { name: 'Titre de la tâche' })
  expect(document.activeElement).toBe(title)
  expect(container.querySelector('.todo-agent-options')?.hasAttribute('open')).toBe(false)
  fireEvent.change(title, { target: { value: '  Réparer le raccourci  ' } })
  await waitFor(() => expect((screen.getByRole('button', { name: 'Créer la tâche' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.keyDown(title, { key: 'Enter', ctrlKey: true })
  await waitFor(() => expect(created).toHaveBeenCalledTimes(1))
  const input = requests.find((request) => request.method === 'POST')?.body
  expect(input).toEqual(expect.objectContaining({ title: 'Réparer le raccourci', message: 'Réparer le raccourci', status: 'backlog', provider: 'codex', model: 'gpt-5.6-sol', presetId: 'todo-preset' }))
  expect(requests.some((request) => request.path.endsWith('/dashboard'))).toBe(false)
  expect(requests.some((request) => request.path.endsWith('/start'))).toBe(false)
})

test('le brouillon conserve description, pièce jointe, configuration et ticket même sans intégration configurée', async () => {
  const attachment = { name: 'brief.pdf', originalName: 'Brief.pdf', mimeType: 'application/pdf', size: 123 }
  const initial = {
    message: 'Réparer le raccourci\nConserver le focus après fermeture.', attachments: [attachment], ticketId: 'ticket-42',
    config: { provider: 'claude' as const, model: 'opus', effort: 'high', speed: 'standard' as const, permissionMode: null, orchestrator: true, subagentPresetId: null, subagentEffort: null, branch: 'TECH-42' },
  }
  render(createElement(TodoEditor, { project, items: [], quotas, initial, onCreated: () => {}, onCancel: () => {} }))
  await waitFor(() => expect((screen.getByRole('button', { name: 'Créer la tâche' }) as HTMLButtonElement).disabled).toBe(false))
  expect((screen.getByRole('textbox', { name: 'Titre de la tâche' }) as HTMLInputElement).value).toBe('Réparer le raccourci')
  expect(screen.getByRole('combobox', { name: 'Ticket lié' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Créer la tâche' }))
  await waitFor(() => expect(requests.some((request) => request.method === 'POST')).toBe(true))
  const input = requests.find((request) => request.method === 'POST')?.body as unknown as TodoInput
  expect(input.message).toBe(initial.message)
  expect(input.attachments).toEqual([attachment])
  expect(input.ticketId).toBe('ticket-42')
  expect(input.model).toBe('opus')
  expect(input.targetBranch).toBe('TECH-42')
})

test('terminer une tâche enregistre le titre puis la clôture sans lancer de conversation', async () => {
  const changed = mock(() => {})
  render(createElement(TodoDetail, { project, item: task, items: [task], quotas, onChanged: changed, onDeleted: () => {}, onConversationSelect: () => {} }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Titre de la tâche' }), { target: { value: 'Raccourci corrigé' } })
  fireEvent.click(screen.getByRole('button', { name: 'Terminer' }))
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(1))
  const writes = requests.filter((request) => request.method !== 'GET')
  expect(writes.map(({ path, method }) => [path, method])).toEqual([['/api/todos/task-1', 'PATCH'], ['/api/todos/task-1/complete', 'POST']])
  expect(writes[0].body?.message).toBe('Raccourci corrigé')
})

test('une branche existante interdit les actions manuelles et une tâche agent attend sa validation', () => {
  const props = { project, items: [task], quotas, onChanged: () => {}, onDeleted: () => {}, onConversationSelect: () => {} }
  const { rerender } = render(createElement(TodoDetail, { ...props, item: { ...task, branch: 'todo/task-1' } }))
  expect(screen.queryByRole('button', { name: 'Terminer' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Lancer l’agent' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Supprimer la tâche' })).toBeNull()
  rerender(createElement(TodoDetail, { ...props, item: { ...task, status: 'awaiting_validation', conversation_id: 'conversation-1', branch: 'todo/task-1' } }))
  expect(screen.queryByRole('button', { name: 'Terminer' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Valider, intégrer et pousser' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Ouvrir la conversation →' })).toBeTruthy()
})

test('une tâche terminée manuellement peut être rouverte dans le backlog', async () => {
  const changed = mock(() => {})
  render(createElement(TodoDetail, { project, item: { ...task, status: 'done' }, items: [task], quotas, onChanged: changed, onDeleted: () => {}, onConversationSelect: () => {} }))
  fireEvent.click(screen.getByRole('button', { name: 'Rouvrir la tâche' }))
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(1))
  expect(requests.filter((request) => request.method === 'POST').map(({ path }) => path)).toEqual(['/api/todos/task-1/reopen'])
})

test('les vérifications bloquent le lancement automatique mais pas la capture de la tâche', async () => {
  const created = mock(() => {})
  const { unmount } = render(createElement(TodoEditor, { project, items: [], quotas, onCreated: created, onCancel: () => {} }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Titre de la tâche' }), { target: { value: 'À préciser' } })
  const options = document.querySelector('.todo-agent-options') as HTMLDetailsElement
  options.open = true
  fireEvent.click(screen.getByRole('checkbox', { name: /Intégrer et pousser/ }))
  await waitFor(() => expect((screen.getByRole('button', { name: 'Créer la tâche' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: 'Créer la tâche' }))
  await waitFor(() => expect(created).toHaveBeenCalledTimes(1))
  unmount()
  await act(async () => { render(createElement(TodoDetail, { project, item: { ...task, integrate: true }, items: [task], quotas, onChanged: () => {}, onDeleted: () => {}, onConversationSelect: () => {} })) })
  expect((screen.getByRole('button', { name: 'Lancer l’agent' }) as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByRole('button', { name: 'Enregistrer les modifications' }) as HTMLButtonElement).disabled).toBe(false)
})
