import { useState } from 'react'
import { completeTodo, reopenTodo, reorderTodos, setTodoQueue, TODO_LABELS, type TodoSnapshot, type TodoStatus } from './todos'
import type { TicketLinks } from './ticketLinks'
import './styles/project-todos.css'

interface Props extends TodoSnapshot {
  projectId: string
  selectedId: string | null
  loading: boolean
  error: string | null
  ticketLinks?: Map<string, TicketLinks>
  onSelect: (id: string) => void
  onChanged: () => void
}
const GROUPS: TodoStatus[] = ['blocked', 'running', 'awaiting_validation', 'backlog', 'queued', 'done']
const GROUP_LABELS: Record<TodoStatus, string> = { backlog: 'À faire', queued: 'En file', running: 'En cours', awaiting_validation: 'À valider', blocked: 'Bloquées', done: 'Terminées' }

export function TodoList({ projectId, items, queue, selectedId, loading, error, ticketLinks, onSelect, onChanged }: Props) {
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'open' | 'done' | 'all'>('open')
  const visible = items.filter((item) => (filter === 'all' || (filter === 'done' ? item.status === 'done' : item.status !== 'done'))
    && `${item.title} ${item.message} ${ticketLinks?.get(item.ticket_id ?? '')?.ticketKey ?? ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  const pending = items.filter((item) => item.status === 'queued')
  async function act(action: () => Promise<unknown>) {
    setBusy(true); setActionError(null)
    try { await action(); onChanged() } catch (reason) { setActionError(reason instanceof Error ? reason.message : 'Action impossible') }
    finally { setBusy(false) }
  }
  function move(id: string, direction: number) {
    const ids = pending.map((item) => item.id)
    const index = ids.indexOf(id)
    const other = index + direction
    if (index < 0 || other < 0 || other >= ids.length) return
    ;[ids[index], ids[other]] = [ids[other]!, ids[index]!]
    void act(() => reorderTodos(projectId, ids))
  }
  return <div className="todo-list project-task-list">
    <div className="project-task-filters">
      <input aria-label="Rechercher une tâche" placeholder="Rechercher…" value={query} onChange={(event) => setQuery(event.target.value)} />
      <select aria-label="Afficher les tâches" value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}>
        <option value="open">Ouvertes</option><option value="done">Terminées</option><option value="all">Toutes</option>
      </select>
    </div>
    {pending.length > 0 || queue.running || queue.activeTodoId ? <div className="project-task-queue">
      <span role="status">{queue.running ? 'Exécution de la file' : queue.activeTodoId ? 'Pause après la tâche en cours' : `${pending.length} en file`}</span>
      <button type="button" className="text-button" disabled={busy || (!queue.running && pending.length === 0)} onClick={() => void act(() => setTodoQueue(projectId, !queue.running))}>{queue.running ? 'Mettre en pause' : 'Lancer la file'}</button>
    </div> : null}
    {error || actionError ? <p className="todo-error" role="alert">{actionError ?? error}</p> : null}
    {loading ? <p className="list-empty">Chargement…</p> : !items.length ? <div className="project-task-empty"><strong>Aucune tâche pour le moment</strong><p>Note un bug, une idée ou une amélioration. Tu pourras ensuite t’en occuper ou la confier à un agent.</p></div> : !visible.length ? <p className="list-empty">{query ? 'Aucune tâche ne correspond.' : filter === 'done' ? 'Aucune tâche terminée.' : 'Toutes les tâches sont terminées.'}</p> : null}
    {GROUPS.map((status) => {
      const group = visible.filter((item) => item.status === status)
      if (!group.length) return null
      return <section className="project-task-group" key={status} aria-label={GROUP_LABELS[status]}>
        <h3>{GROUP_LABELS[status]} <span>{group.length}</span></h3>
        {group.map((item) => {
          const manual = !item.conversation_id && !item.branch && !item.worktree_path && ['backlog', 'queued', 'blocked', 'done'].includes(item.status)
          const ticket = ticketLinks?.get(item.ticket_id ?? '')
          return <div className={`todo-row project-task-row ${item.id === selectedId ? 'is-selected' : ''}`} key={item.id} data-status={item.status}>
            {manual ? <button type="button" className={`project-task-check is-${item.status}`} disabled={busy} aria-label={`${item.status === 'done' ? 'Rouvrir' : 'Terminer'} ${item.title}`} onClick={() => void act(() => item.status === 'done' ? reopenTodo(item.id) : completeTodo(item.id))}>{item.status === 'done' ? '✓' : null}</button>
              : <span className={`project-task-status is-${item.status}`} title={TODO_LABELS[item.status]} aria-label={TODO_LABELS[item.status]}>{item.status === 'blocked' ? '!' : item.status === 'done' ? '✓' : item.status === 'running' ? '◐' : '◷'}</span>}
            <button type="button" className="todo-row-main" onClick={() => onSelect(item.id)} aria-current={item.id === selectedId ? 'true' : undefined}>
              <span className="todo-row-title">{item.title}</span>
              {ticket || item.integrate || item.conversation_id ? <span className="project-task-meta">{[ticket?.ticketKey, item.conversation_id ? 'Conversation liée' : null, item.integrate ? 'Intégration auto' : null].filter(Boolean).join(' · ')}</span> : null}
            </button>
            {item.status === 'queued' ? <div className="todo-row-order">
              <button type="button" disabled={busy || pending[0]?.id === item.id} aria-label={`Monter ${item.title}`} onClick={() => move(item.id, -1)}>↑</button>
              <button type="button" disabled={busy || pending.at(-1)?.id === item.id} aria-label={`Descendre ${item.title}`} onClick={() => move(item.id, 1)}>↓</button>
            </div> : null}
          </div>
        })}
      </section>
    })}
  </div>
}
