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
  finish: 'none', conversation_id: null, branch: null,
  worktree_path: null, error: null, position: 0, created_at: '', updated_at: '', provider: 'codex',
  model: 'gpt-5.6-sol', effort: 'high', attachments: [], ...extra,
})
const defaults = { projectId: 'project', selectedId: null, loading: false, error: null, queue: { running: false, activeTodoId: null }, onChanged: () => {}, onOpenConversation: () => {} }
function recordCalls() {
  const calls: { url: string; body: unknown }[] = []
  globalThis.fetch = (async (url, options) => { calls.push({ url: String(url), body: options?.body ? JSON.parse(String(options.body)) : undefined }); return Response.json({}) }) as typeof fetch
  return calls
}

test('one ordered pile of open tasks, done tasks behind their own tab', () => {
  const items = [item('Idea', 'backlog'), item('Queue', 'queued'), item('Work', 'running', { conversation_id: 'conversation' }), item('Review', 'awaiting_validation', { conversation_id: 'c2' }), item('Blocked', 'blocked'), item('Done', 'done')]
  render(<TodoList {...defaults} items={items} />)
  expect([...document.querySelectorAll('.project-task-row .todo-row-title')].map((node) => node.textContent)).toEqual(['Idea', 'Queue', 'Work', 'Review', 'Blocked'])
  expect(screen.getByRole('tab', { name: 'Ouvertes 5' }).getAttribute('aria-selected')).toBe('true')
  fireEvent.click(screen.getByRole('tab', { name: 'Terminées 1' }))
  expect(document.querySelectorAll('.project-task-row').length).toBe(1)
  expect(screen.getByRole('button', { name: 'Rouvrir Done' })).toBeDefined()
})

test('every non-running task can be closed or removed, a running one only shows a spinner', async () => {
  const calls = recordCalls()
  render(<TodoList {...defaults} items={[item('Idea', 'backlog'), item('Executed', 'blocked', { conversation_id: 'conversation', error: 'Échec du push' }), item('Work', 'running', { conversation_id: 'c3' })]} />)
  expect(screen.queryByRole('button', { name: 'Terminer Work' })).toBeNull()
  expect((screen.getByRole('button', { name: 'Supprimer Work' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Terminer Executed' }))
  await waitFor(() => expect(calls.map((call) => call.url)).toEqual(['/api/todos/Executed/complete']))
  expect(document.querySelector('.project-task-row.is-leaving .todo-row-title')?.textContent).toBe('Executed')
  fireEvent.click(screen.getByRole('button', { name: 'Supprimer Idea' }))
  await waitFor(() => expect(calls.at(-1)?.url).toBe('/api/todos/Idea'))
})

test('drain sends the whole backlog, the queue button pauses it once running', async () => {
  const calls = recordCalls()
  const { rerender } = render(<TodoList {...defaults} items={[item('First', 'backlog'), item('Second', 'backlog'), item('Blocked', 'blocked')]} />)
  expect(screen.getByRole('status').textContent).toContain('2 à dépiler')
  fireEvent.click(screen.getByRole('button', { name: 'Dépiler' }))
  await waitFor(() => expect(calls.map((call) => call.url)).toEqual(['/api/projects/project/todos/drain']))
  rerender(<TodoList {...defaults} queue={{ running: true, activeTodoId: 'First' }} items={[item('First', 'running', { conversation_id: 'c' }), item('Second', 'queued')]} />)
  expect(screen.getByRole('status').textContent).toContain('Dépilage en cours')
  fireEvent.click(screen.getByRole('button', { name: 'Mettre en pause' }))
  await waitFor(() => expect(calls.at(-1)).toEqual({ url: '/api/projects/project/todos/queue', body: { running: false } }))
})

test('rows expose start, conversation and prefilled-conversation shortcuts', async () => {
  const calls = recordCalls()
  const opened: string[] = []
  render(<TodoList {...defaults} onOpenConversation={(todo) => opened.push(todo.id)} items={[item('Idea', 'backlog'), item('Linked', 'awaiting_validation', { conversation_id: 'conversation' })]} />)
  expect(screen.queryByRole('button', { name: 'Lancer l’agent sur Linked' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Lancer l’agent sur Idea' }))
  await waitFor(() => expect(calls.map((call) => call.url)).toEqual(['/api/todos/Idea/start']))
  fireEvent.click(screen.getByRole('button', { name: 'Linked À valider' }))
  fireEvent.click(screen.getByRole('button', { name: 'Idea' }))
  expect(opened).toEqual(['Linked', 'Idea'])
  expect(document.querySelectorAll('.project-task-linked').length).toBe(1)
})

test('search matches linked ticket keys and keeps selection', () => {
  render(<TodoList {...defaults} selectedId="Idea" items={[item('Idea', 'backlog', { ticket_id: 'ticket' }), item('Another', 'backlog')]} ticketLinks={new Map([['ticket', { ticketKey: 'TECH-24024', externalUrl: null, mergeRequestUrl: null, branch: null }]])} />)
  fireEvent.change(screen.getByLabelText('Rechercher une tâche'), { target: { value: '24024' } })
  expect(document.querySelectorAll('.project-task-row').length).toBe(1)
  expect(screen.getByRole('button', { name: 'Idea TECH-24024' }).getAttribute('aria-current')).toBe('true')
})

test('drag and drop reorders the whole open pile, keyboard moves one step', async () => {
  const calls = recordCalls()
  render(<TodoList {...defaults} items={[item('First', 'backlog'), item('Second', 'queued'), item('Third', 'blocked'), item('Done', 'done')]} />)
  const rows = document.querySelectorAll('.project-task-row')
  expect([...rows].every((row) => row.getAttribute('draggable') === 'true')).toBe(true)
  fireEvent.dragStart(rows[2]!, { dataTransfer: { setData: () => {}, getData: () => 'Third', effectAllowed: 'move' } })
  fireEvent.dragOver(rows[0]!, { dataTransfer: { dropEffect: 'move' } })
  expect(rows[0]!.classList.contains('is-drop-target')).toBe(true)
  fireEvent.drop(rows[0]!, { dataTransfer: { getData: () => 'Third' } })
  await waitFor(() => expect(calls.at(-1)).toEqual({ url: '/api/projects/project/todos/reorder', body: { ids: ['Third', 'First', 'Second'] } }))
  fireEvent.keyDown(screen.getByRole('button', { name: 'Second En file' }), { key: 'ArrowUp', altKey: true })
  await waitFor(() => expect(calls.at(-1)?.body).toEqual({ ids: ['Second', 'First', 'Third'] }))
})
