import { useEffect, useRef, useState } from 'react'
import type { TicketLinks } from './ticketLinks'
import { acceptTodo, deleteTodo, updateTodo, type TodoItem } from './todos'

type Verdict = 'kept' | 'dropped'
const SETTLE_DELAY = 1300

export function TodoSuggestions({ items, ticketLinks, onChanged }: { items: TodoItem[]; ticketLinks?: Map<string, TicketLinks>; onChanged: () => void }) {
  const [settled, setSettled] = useState<Record<string, { item: TodoItem; verdict: Verdict }>>({})
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<{ ticketId: string; branch: string }>({ ticketId: '', branch: '' })
  const [scopes, setScopes] = useState<Record<string, { ticket_id: string | null; target_branch: string }>>({})
  const [failed, setFailed] = useState<string | null>(null)
  const order = useRef<string[]>([])
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  useEffect(() => () => timers.current.forEach(clearTimeout), [])

  for (const item of items) if (!order.current.includes(item.id)) order.current.push(item.id)
  const shown = [...items.filter((item) => !settled[item.id]), ...Object.values(settled).map((entry) => entry.item)]
    .sort((a, b) => order.current.indexOf(a.id) - order.current.indexOf(b.id))
  if (!shown.length) return null
  const pending = items.filter((item) => !settled[item.id]).length

  function startEditing(item: TodoItem) {
    setDraft({ ticketId: item.ticket_id ?? '', branch: item.target_branch ?? '' })
    setEditing(item.id)
  }
  async function saveScope(item: TodoItem) {
    setFailed(null)
    try {
      await updateTodo(item.id, { ticketId: draft.ticketId || null, targetBranch: draft.branch.trim() })
    } catch (reason) {
      setFailed(reason instanceof Error ? reason.message : 'Action impossible')
      return
    }
    setScopes((current) => ({ ...current, [item.id]: { ticket_id: draft.ticketId || null, target_branch: draft.branch.trim() } }))
    setEditing(null)
    onChanged()
  }
  async function decide(item: TodoItem, verdict: Verdict) {
    setFailed(null)
    try {
      await (verdict === 'kept' ? acceptTodo(item.id) : deleteTodo(item.id))
    } catch (reason) {
      setFailed(reason instanceof Error ? reason.message : 'Action impossible')
      return
    }
    setSettled((current) => ({ ...current, [item.id]: { item, verdict } }))
    timers.current.push(setTimeout(() => {
      setSettled((current) => { const { [item.id]: _gone, ...rest } = current; return rest })
      onChanged()
    }, SETTLE_DELAY))
  }

  return <section className="todo-suggestions" aria-label="Chantiers repérés pour plus tard">
    <header>
      <svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M8 1.2l1.5 3.9 3.9 1.5-3.9 1.5L8 12l-1.5-3.9L2.6 6.6l3.9-1.5z" /><path d="M13 10.5l.6 1.5 1.5.6-1.5.6-.6 1.5-.6-1.5-1.5-.6 1.5-.6z" opacity=".7" /></svg>
      <h4>{pending > 0 ? `${pending} chantier${pending > 1 ? 's' : ''} repéré${pending > 1 ? 's' : ''} pour plus tard` : 'Pile à jour'}</h4>
    </header>
    <ul>
      {shown.map((shownItem) => {
        const item = { ...shownItem, ...scopes[shownItem.id] }
        const verdict = settled[item.id]?.verdict
        const ticket = item.ticket_id ? ticketLinks?.get(item.ticket_id)?.ticketKey ?? 'Ticket lié' : 'Sans ticket'
        return <li key={item.id} className={verdict ? `is-${verdict}` : undefined}>
          <div className="todo-suggestion-body">
            <strong title={item.message}>{item.title}</strong>
            {item.origin?.reason ? <p>{item.origin.reason}</p> : null}
            {editing === item.id ? <form className="todo-suggestion-edit" onSubmit={(event) => { event.preventDefault(); void saveScope(item) }}>
              <select aria-label="Ticket" value={draft.ticketId} onChange={(event) => setDraft({ ...draft, ticketId: event.target.value })}>
                <option value="">Sans ticket</option>
                {[...(ticketLinks ?? [])].map(([id, links]) => <option key={id} value={id}>{links.ticketKey}{links.title ? ` · ${links.title}` : ''}</option>)}
              </select>
              <input aria-label="Branche cible" placeholder="branche principale" value={draft.branch} onChange={(event) => setDraft({ ...draft, branch: event.target.value })} />
              <button type="submit" className="is-keep">OK</button>
              <button type="button" onClick={() => setEditing(null)}>Annuler</button>
            </form> : <div className="todo-suggestion-scope">
              <span className={item.ticket_id ? 'is-ticket' : undefined}>{ticket}</span>
              <span>{item.target_branch ? `sur ${item.target_branch}` : 'branche principale'}</span>
              {!verdict ? <button type="button" onClick={() => startEditing(item)}>Changer</button> : null}
            </div>}
          </div>
          {verdict
            ? <span className="todo-suggestion-verdict" role="status">{verdict === 'kept' ? '✓ Ajoutée à la pile' : 'Écartée'}</span>
            : <div className="todo-suggestion-actions">
                <button type="button" className="is-keep" onClick={() => void decide(item, 'kept')}>Garder</button>
                <button type="button" className="is-drop" onClick={() => void decide(item, 'dropped')}>Écarter</button>
              </div>}
        </li>
      })}
    </ul>
    {failed ? <p className="todo-suggestion-error" role="alert">{failed}</p> : null}
  </section>
}
