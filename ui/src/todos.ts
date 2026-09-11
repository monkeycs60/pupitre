import { useCallback, useEffect, useState } from 'react'
import type { Attachment, ConversationSpeed, PresetPermissionMode, Provider } from './types'
import { httpUrl } from './transport'

export type TodoStatus = 'backlog' | 'queued' | 'running' | 'awaiting_validation' | 'done' | 'blocked'
export type TodoFinish = 'none' | 'commit' | 'commit_push'
export const TODO_FINISH_LABELS: Record<TodoFinish, string> = { none: 'Sans commit', commit: 'Commit', commit_push: 'Commit & push' }
export interface TodoInput {
  status?: 'backlog' | 'queued'
  title?: string
  message: string
  targetBranch?: string | null
  ticketId?: string | null
  finish?: TodoFinish
  provider: Provider
  model: string
  effort?: string | null
  speed?: ConversationSpeed | null
  presetId?: string | null
  permissionMode?: PresetPermissionMode | null
  images?: string[]
  attachments?: Attachment[]
}
export interface TodoItem {
  id: string
  project_id: string
  title: string
  message: string
  ticket_id: string | null
  target_branch: string | null
  finish: TodoFinish
  status: TodoStatus
  execution_completed?: boolean
  conversation_id: string | null
  branch: string | null
  worktree_path: string | null
  error: string | null
  position: number
  created_at: string
  updated_at: string
  provider: Provider
  model: string
  effort: string | null
  speed?: ConversationSpeed | null
  preset_id?: string | null
  permission_mode?: PresetPermissionMode | null
  attachments: Attachment[]
}
export interface TodoSnapshot {
  items: TodoItem[]
  queue: { running: boolean; activeTodoId: string | null }
}
export const TODO_LABELS: Record<TodoStatus, string> = {
  backlog: 'À faire', queued: 'En file', running: 'En cours', awaiting_validation: 'À valider', done: 'Terminée', blocked: 'Bloquée',
}
/** Une tâche que la pile peut encore confier à un agent : aucune exécution n'a commencé. */
export function isStartable(item: TodoItem): boolean {
  return ['backlog', 'queued', 'blocked'].includes(item.status)
    && !item.conversation_id && !item.branch && !item.worktree_path && !item.execution_completed
}
export async function todoRequest<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(httpUrl(path), {
    method, signal, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) {
    const data = await response.json().catch(() => null) as { error?: string } | null
    throw new Error(data?.error ?? `Action impossible (${response.status})`)
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>
}
export const createTodo = (projectId: string, input: TodoInput) => todoRequest<TodoItem>(`/api/projects/${encodeURIComponent(projectId)}/todos`, 'POST', input)
export const updateTodo = (id: string, input: Partial<TodoInput>) => todoRequest<TodoItem>(`/api/todos/${encodeURIComponent(id)}`, 'PATCH', input)
export const completeTodo = (id: string) => todoRequest<TodoItem>(`/api/todos/${encodeURIComponent(id)}/complete`, 'POST', {})
export const reopenTodo = (id: string) => todoRequest<TodoItem>(`/api/todos/${encodeURIComponent(id)}/reopen`, 'POST', {})
export const enqueueTodo = (id: string) => todoRequest(`/api/todos/${encodeURIComponent(id)}/enqueue`, 'POST', {})
export const startTodo = (id: string) => todoRequest(`/api/todos/${encodeURIComponent(id)}/start`, 'POST', {})
export const linkTodo = (id: string, conversationId: string) => todoRequest<TodoItem>(`/api/todos/${encodeURIComponent(id)}/link`, 'POST', { conversationId })
export const deleteTodo = (id: string) => todoRequest(`/api/todos/${encodeURIComponent(id)}`, 'DELETE')
export const setTodoQueue = (projectId: string, running: boolean) => todoRequest(`/api/projects/${encodeURIComponent(projectId)}/todos/queue`, 'POST', { running })
export const reorderTodos = (projectId: string, ids: string[]) => todoRequest(`/api/projects/${encodeURIComponent(projectId)}/todos/reorder`, 'POST', { ids })
export const drainTodos = (projectId: string) => todoRequest<TodoSnapshot>(`/api/projects/${encodeURIComponent(projectId)}/todos/drain`, 'POST', {})

const EMPTY: TodoSnapshot = { items: [], queue: { running: false, activeTodoId: null } }
export function useTodos(projectId: string | null) {
  const [result, setResult] = useState<{ projectId: string; snapshot: TodoSnapshot } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const refresh = useCallback(() => setVersion((value) => value + 1), [])
  useEffect(() => {
    if (!projectId) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    async function poll() {
      try {
        const snapshot = await todoRequest<TodoSnapshot>(`/api/projects/${encodeURIComponent(projectId!)}/todos`, 'GET', undefined, controller.signal)
        if (!controller.signal.aborted) { setResult({ projectId: projectId!, snapshot }); setError(null) }
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Chargement des TODO impossible')
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, 3000)
      }
    }
    void poll()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [projectId, version])
  return { ...(result?.projectId === projectId ? result.snapshot : EMPTY), loading: !!projectId && result?.projectId !== projectId && !error, error, refresh }
}
