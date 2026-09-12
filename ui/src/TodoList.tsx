import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import { completeTodo, deleteTodo, drainTodos, isStartable, reopenTodo, reorderTodos, setTodoQueue, startTodo, TODO_FINISH_LABELS, TODO_LABELS, type TodoItem, type TodoSnapshot } from './todos'
import type { TicketLinks } from './ticketLinks'
import './styles/project-todos.css'

interface Props extends TodoSnapshot {
  projectId: string
  selectedId: string | null
  loading: boolean
  error: string | null
  ticketLinks?: Map<string, TicketLinks>
  onChanged: () => void
  /** Clic sur la ligne : conversation liée si elle existe, sinon nouvelle
   *  conversation préremplie avec la tâche. */
  onOpenConversation: (item: TodoItem) => void
  /** Recharge la tâche dans le composer en mode Tâche ; l'envoi la remplace. */
  onEdit: (item: TodoItem) => void
}

const LEAVE_DELAY = 900

export function TodoList({ projectId, items, queue, selectedId, loading, error, ticketLinks, onChanged, onOpenConversation, onEdit }: Props) {
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<'open' | 'done'>('open')
  const [leaving, setLeaving] = useState<string[]>([])
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  useEffect(() => () => timers.current.forEach(clearTimeout), [])

  const open = items.filter((item) => item.status !== 'done')
  const done = items.filter((item) => item.status === 'done')
  const needle = query.trim().toLocaleLowerCase()
  const matches = (item: TodoItem) => needle === ''
    || `${item.title} ${item.message} ${ticketLinks?.get(item.ticket_id ?? '')?.ticketKey ?? ''}`.toLocaleLowerCase().includes(needle)
  const visible = (tab === 'open' ? items.filter((item) => item.status !== 'done' || leaving.includes(item.id)) : done).filter(matches)
  const startable = open.filter((item) => isStartable(item) && item.status !== 'blocked')
  const canDrag = tab === 'open' && needle === ''

  async function act(action: () => Promise<unknown>) {
    setBusy(true); setActionError(null)
    try { await action(); onChanged() } catch (reason) { setActionError(reason instanceof Error ? reason.message : 'Action impossible') }
    finally { setBusy(false) }
  }
  function complete(item: TodoItem) {
    setLeaving((current) => [...current, item.id])
    timers.current.push(setTimeout(() => setLeaving((current) => current.filter((id) => id !== item.id)), LEAVE_DELAY))
    void act(() => completeTodo(item.id))
  }
  function reorder(id: string, target: string) {
    const ids = open.map((item) => item.id)
    const from = ids.indexOf(id), to = ids.indexOf(target)
    if (from < 0 || to < 0 || from === to) return
    ids.splice(from, 1)
    ids.splice(to, 0, id)
    void act(() => reorderTodos(projectId, ids))
  }
  function move(id: string, direction: -1 | 1) {
    const ids = open.map((item) => item.id)
    const index = ids.indexOf(id)
    const other = index + direction
    if (index < 0 || other < 0 || other >= ids.length) return
    ;[ids[index], ids[other]] = [ids[other]!, ids[index]!]
    void act(() => reorderTodos(projectId, ids))
  }
  function handleRowKeyDown(event: KeyboardEvent<HTMLButtonElement>, item: TodoItem) {
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') || !canDrag) return
    event.preventDefault()
    move(item.id, event.key === 'ArrowUp' ? -1 : 1)
  }
  function handleDragStart(event: DragEvent<HTMLLIElement>, item: TodoItem) {
    setDragId(item.id)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', item.id)
  }
  function handleDrop(event: DragEvent<HTMLLIElement>, target: TodoItem) {
    event.preventDefault()
    const id = dragId ?? event.dataTransfer.getData('text/plain')
    setDragId(null); setOverId(null)
    if (id && id !== target.id) reorder(id, target.id)
  }

  return <div className="todo-list project-task-list">
    <div className="project-task-toolbar">
      <div className="project-task-tabs" role="tablist" aria-label="Afficher les tâches">
        <button type="button" role="tab" aria-selected={tab === 'open'} onClick={() => setTab('open')}>Ouvertes <span>{open.length}</span></button>
        <button type="button" role="tab" aria-selected={tab === 'done'} onClick={() => setTab('done')}>Terminées <span>{done.length}</span></button>
      </div>
      <label className={`project-task-search${query ? ' has-value' : ''}`}>
        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><circle cx="7" cy="7" r="4.2" /><path d="m10.2 10.2 3 3" strokeLinecap="round" /></svg>
        <input aria-label="Rechercher une tâche" placeholder="Filtrer" value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>
    </div>
    {tab === 'open' && (startable.length > 0 || queue.running || queue.activeTodoId) ? <div className={`project-task-queue${queue.running ? ' is-running' : ''}`}>
      <span role="status">
        {queue.activeTodoId ? <span className="project-task-pulse" aria-hidden="true" /> : null}
        {queue.running
          ? queue.activeTodoId ? 'Dépilage en cours' : 'Pile active, en attente'
          : queue.activeTodoId ? 'Pause après la tâche en cours' : `${startable.length} à dépiler, de haut en bas`}
      </span>
      {queue.running
        ? <button type="button" className="secondary-button" disabled={busy} onClick={() => void act(() => setTodoQueue(projectId, false))}>Mettre en pause</button>
        : <button type="button" className="primary-button" disabled={busy || startable.length === 0} onClick={() => void act(() => drainTodos(projectId))}>
            <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" aria-hidden="true"><path d="M4 2.8v10.4L12.5 8z" /></svg>
            Dépiler
          </button>}
    </div> : null}
    {error || actionError ? <p className="todo-error" role="alert">{actionError ?? error}</p> : null}
    {loading ? <p className="list-empty">Chargement…</p>
      : !items.length ? <div className="project-task-empty"><strong>La pile est vide</strong><p>Passe le composer en mode <em>Tâche</em> pour empiler un bug, une idée ou une amélioration, puis dépile quand tu veux.</p></div>
      : !visible.length ? <p className="list-empty">{needle ? 'Aucune tâche ne correspond.' : tab === 'done' ? 'Aucune tâche terminée.' : 'Tout est dépilé.'}</p>
      : null}
    <ol className="project-task-rows" aria-label={tab === 'open' ? 'Tâches ouvertes' : 'Tâches terminées'}>
      {visible.map((item) => {
        const running = item.status === 'running' || queue.activeTodoId === item.id
        const isDone = item.status === 'done'
        const startableItem = isStartable(item)
        const ticket = ticketLinks?.get(item.ticket_id ?? '')
        const classes = ['todo-row', 'project-task-row', `is-${item.status}`]
        if (item.id === selectedId) classes.push('is-selected')
        if (leaving.includes(item.id)) classes.push('is-leaving')
        if (dragId === item.id) classes.push('is-dragging')
        if (overId === item.id && dragId && dragId !== item.id) classes.push('is-drop-target')
        return <li className={classes.join(' ')} key={item.id} data-status={item.status}
          draggable={canDrag && !running}
          onDragStart={(event) => handleDragStart(event, item)}
          onDragOver={(event) => { if (dragId && canDrag) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; if (overId !== item.id) setOverId(item.id) } }}
          onDragLeave={() => { if (overId === item.id) setOverId(null) }}
          onDrop={(event) => handleDrop(event, item)}
          onDragEnd={() => { setDragId(null); setOverId(null) }}>
          {canDrag ? <span className="project-task-grip" aria-hidden="true" title="Glisser pour réordonner · Alt + ↑/↓"><svg viewBox="0 0 8 14" width="8" height="14" fill="currentColor"><circle cx="2" cy="2" r="1.1" /><circle cx="6" cy="2" r="1.1" /><circle cx="2" cy="7" r="1.1" /><circle cx="6" cy="7" r="1.1" /><circle cx="2" cy="12" r="1.1" /><circle cx="6" cy="12" r="1.1" /></svg></span> : null}
          {running
            ? <span className="project-task-check is-running" role="img" aria-label="En cours"><span className="project-task-spinner" /></span>
            : <button type="button" className={`project-task-check is-${item.status}`} disabled={busy} aria-label={`${isDone ? 'Rouvrir' : 'Terminer'} ${item.title}`} title={isDone ? 'Rouvrir' : 'Marquer terminée'} onClick={() => isDone ? void act(() => reopenTodo(item.id)) : complete(item)}>
                <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m2.5 6.3 2.3 2.3 4.7-5" /></svg>
              </button>}
          <button type="button" className="todo-row-main" title={item.conversation_id ? 'Ouvrir la conversation liée' : 'Ouvrir dans une conversation préremplie'} onClick={() => onOpenConversation(item)} onKeyDown={(event) => handleRowKeyDown(event, item)} aria-current={item.id === selectedId ? 'true' : undefined}>
            <span className="todo-row-title">{item.title}</span>
            <span className="project-task-meta">
              {item.status !== 'backlog' && !isDone ? <span className={`project-task-state is-${item.status}`} title={item.error ?? undefined}>{TODO_LABELS[item.status]}</span> : null}
              {ticket?.ticketKey ? <span className="project-task-ticket">{ticket.ticketKey}</span> : null}
              {item.finish !== 'none' ? <span title={item.commit_message ?? undefined}>{item.commit_sha ? `${TODO_FINISH_LABELS[item.finish]} · ${item.commit_sha.slice(0, 7)}` : TODO_FINISH_LABELS[item.finish]}</span> : null}
              {item.branch_url ? <a className="project-task-link" href={item.branch_url} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>Branche ↗</a> : null}
              {item.merge_request_url ? <a className="project-task-link" href={item.merge_request_url} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>Créer la MR ↗</a> : null}
              {item.error && item.status === 'blocked' ? <span className="project-task-error" title={item.error}>{item.error}</span> : null}
            </span>
          </button>
          <span className="project-task-actions">
            {startableItem && !isDone ? <button type="button" disabled={busy} aria-label={`Modifier ${item.title}`} title="Modifier dans le composer" onClick={() => onEdit(item)}>
              <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m11.2 2.8 2 2L5.5 12.5l-2.7.7.7-2.7z" /></svg>
            </button> : null}
            {startableItem && !isDone ? <button type="button" disabled={busy || !!queue.activeTodoId} aria-label={`Lancer l’agent sur ${item.title}`} title="Lancer l’agent" onClick={() => void act(() => startTodo(item.id))}>
              <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M4.5 3v10L12.5 8z" /></svg>
            </button> : null}
            {item.conversation_id ? <span className="project-task-linked" aria-hidden="true" title="Conversation liée">
              <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" /><path d="M5.5 7h5" strokeLinecap="round" /></svg>
            </span> : null}
            <button type="button" className="is-danger" disabled={busy || running} aria-label={`Supprimer ${item.title}`} title="Supprimer" onClick={() => void act(() => deleteTodo(item.id))}>
              <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
            </button>
          </span>
        </li>
      })}
    </ol>
  </div>
}
