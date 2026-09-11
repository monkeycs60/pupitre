import { afterEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { TodoItem } from './todos'

if (typeof document === 'undefined') GlobalRegistrator.register()
const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { TodoList } = await import('./TodoList')
const originalFetch = globalThis.fetch
afterEach(() => { cleanup(); globalThis.fetch = originalFetch })
const item = (id: string, status: TodoItem['status'], extra: Partial<TodoItem> = {}): TodoItem => ({
  id, title: id, status, message: id, project_id: 'project', ticket_id: null, target_branch: null,
  integrate: false, autonomy: 'local', depends_on: null, conversation_id: null, branch: null,
  worktree_path: null, error: null, position: 0, created_at: '', updated_at: '', provider: 'codex',
  model: 'gpt-5.6-sol', effort: 'high', attachments: [], checks: [], ...extra,
})
const defaults = { projectId: 'project', selectedId: null, loading: false, error: null, queue: { running: false, activeTodoId: null }, onSelect: () => {}, onChanged: () => {} }

test('groups all open states once and filters completed tasks', () => {
  const items = [item('Idea', 'backlog'), item('Queue', 'queued'), item('Work', 'running', { conversation_id: 'conversation' }), item('Review', 'awaiting_validation'), item('Blocked', 'blocked'), item('Done', 'done')]
  render(<TodoList {...defaults} items={items} />)
  expect(document.querySelectorAll('.project-task-row').length).toBe(5)
  expect(screen.queryByText('Done', { exact: true })).toBeNull()
  fireEvent.change(screen.getByLabelText('Afficher les tâches'), { target: { value: 'done' } })
  expect(document.querySelectorAll('.project-task-row').length).toBe(1)
  expect(screen.getByRole('button', { name: 'Rouvrir Done' })).toBeDefined()
})

test('captures manual closure without launching agent and offers no closure for executions', async () => {
  const calls: string[] = []
  globalThis.fetch = (async (url) => { calls.push(String(url)); return Response.json({}) }) as typeof fetch
  render(<TodoList {...defaults} items={[item('Idea', 'backlog'), item('Executed', 'blocked', { conversation_id: 'conversation' }), item('Orphan branch', 'blocked', { branch: 'codex/task' })]} />)
  expect(screen.queryByRole('button', { name: 'Terminer Executed' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Terminer Orphan branch' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Terminer Idea' }))
  await waitFor(() => expect(calls).toEqual(['/api/todos/Idea/complete']))
})

test('search matches linked ticket keys and keeps selection', () => {
  render(<TodoList {...defaults} selectedId="Idea" items={[item('Idea', 'backlog', { ticket_id: 'ticket' }), item('Another', 'backlog')]} ticketLinks={new Map([['ticket', { ticketKey: 'TECH-24024', externalUrl: null, mergeRequestUrl: null, branch: null }]])} />)
  fireEvent.change(screen.getByLabelText('Rechercher une tâche'), { target: { value: '24024' } })
  expect(document.querySelectorAll('.project-task-row').length).toBe(1)
  expect(screen.getByRole('button', { name: 'Idea TECH-24024' }).getAttribute('aria-current')).toBe('true')
})

test('reordering includes only queued items even with backlog or filtered results', async () => {
  const requests: unknown[] = []
  globalThis.fetch = (async (_url, options) => { requests.push(JSON.parse(String(options?.body))); return Response.json({}) }) as typeof fetch
  render(<TodoList {...defaults} items={[item('Idea', 'backlog'), item('First', 'queued'), item('Last', 'queued')]} />)
  fireEvent.click(screen.getByRole('button', { name: 'Monter Last' }))
  await waitFor(() => expect(requests).toEqual([{ ids: ['Last', 'First'] }]))
})
