import { useState } from 'react'
import { reorderTodos, setTodoQueue, TODO_LABELS, type TodoSnapshot } from './todos'

interface Props extends TodoSnapshot {
  projectId: string
  selectedId: string | null
  loading: boolean
  error: string | null
  onSelect: (id: string) => void
  onChanged: () => void
}
export function TodoList({ projectId, items, queue, selectedId, loading, error, onSelect, onChanged }: Props) {
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const visible = items.filter((item) => `${item.title} ${item.message}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  const pending = items.filter((item) => item.status === 'queued').length
  async function act(action: () => Promise<unknown>) {
    setBusy(true); setActionError(null)
    try { await action(); onChanged() } catch (reason) { setActionError(reason instanceof Error ? reason.message : 'Action impossible') }
    finally { setBusy(false) }
  }
  function move(id: string, direction: number) {
    const ids = items.filter((item) => item.status === 'queued').map((item) => item.id)
    const index = ids.indexOf(id)
    const other = index + direction
    if (other < 0 || other >= ids.length) return
    ;[ids[index], ids[other]] = [ids[other]!, ids[index]!]
    void act(() => reorderTodos(projectId, ids))
  }
  return <div className="todo-list">
    <div className="todo-queue-control">
      <button className={queue.running ? 'secondary-button' : 'primary-button'} disabled={busy || (!queue.running && pending === 0)} onClick={() => void act(() => setTodoQueue(projectId, !queue.running))}>
        {queue.running ? 'Mettre en pause' : 'Dépiler les TODO'}
      </button>
      <span role="status">{queue.running ? 'Une tâche à la fois' : queue.activeTodoId ? 'Pause après la tâche en cours' : `${pending} à faire`}</span>
    </div>
    {items.length > 0 ? <input className="todo-search" aria-label="Filtrer les TODO" placeholder="Rechercher une TODO…" value={query} onChange={(event) => setQuery(event.target.value)} /> : null}
    {error || actionError ? <p className="sidebar-error" role="alert">{actionError ?? error}</p> : null}
    {loading ? <p className="list-empty">Chargement…</p> : !items.length ? <p className="list-empty">Prépare une TODO : elle démarrera quand tu dépileras la file, dans une branche dédiée.</p> : null}
    {items.length > 0 && !visible.length ? <p className="list-empty">Aucune TODO ne correspond.</p> : null}
    <div className="todo-rows">{visible.map((item) => <div className={`todo-row ${item.id === selectedId ? 'is-selected' : ''}`} key={item.id}>
      <button className="todo-row-main" onClick={() => onSelect(item.id)} aria-current={item.id === selectedId ? 'true' : undefined}>
        <span className="todo-row-title">{item.title}</span>
        <span className={`todo-row-state is-${item.status}`}>{TODO_LABELS[item.status]}{item.integrate ? ' · Intégration auto' : ''}</span>
      </button>
      {item.status === 'queued' ? <div className="todo-row-order">
        <button disabled={busy || items.find((other) => other.status === 'queued')?.id === item.id} aria-label={`Monter ${item.title}`} onClick={() => move(item.id, -1)}>↑</button>
        <button disabled={busy || items.filter((other) => other.status === 'queued').at(-1)?.id === item.id} aria-label={`Descendre ${item.title}`} onClick={() => move(item.id, 1)}>↓</button>
      </div> : null}
    </div>)}</div>
  </div>
}
