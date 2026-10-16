import { useEffect, useRef, useState } from 'react'
import { addConversationTodo } from './todos'

const CONFIRM_DELAY = 1800

export function QuickTodo({ conversationId }: { conversationId: string }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [added, setAdded] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])

  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open])

  async function submit() {
    const message = draft.trim()
    if (!message || busy) return
    setBusy(true)
    setError(null)
    try {
      const created = await addConversationTodo(conversationId, message)
      setDraft('')
      setOpen(false)
      setAdded(created.title)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setAdded(null), CONFIRM_DELAY)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Ajout impossible')
    } finally {
      setBusy(false)
    }
  }

  return <div className="quick-todo" ref={root}>
    <button
      type="button"
      className={`composer-icon-button${added ? ' is-confirmed' : ''}`}
      onClick={() => { setOpen((value) => !value); setError(null) }}
      aria-expanded={open}
      title="Ajouter une tâche à la pile"
      aria-label="Ajouter une tâche"
    >
      {added
        ? <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        : <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m2.5 4 1.2 1.2L6 2.9M8 4h5.5M2.5 9.3l1.2 1.2L6 8.2M8 9.3h2.5M12.5 9v5M10 11.5h5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>}
    </button>
    {added ? <span className="quick-todo-added" role="status">Ajoutée : {added}</span> : null}
    {open ? <div className="quick-todo-popover" role="dialog" aria-label="Nouvelle tâche">
      <textarea
        autoFocus
        rows={2}
        value={draft}
        placeholder="Nouvelle tâche pour plus tard…"
        aria-label="Description de la tâche"
        disabled={busy}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false) }
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit() }
        }}
      />
      <div className="quick-todo-footer">
        {error ? <span className="quick-todo-error" role="alert">{error}</span> : <span>Entrée pour empiler · Échap pour fermer</span>}
        <button type="button" disabled={busy || !draft.trim()} onClick={() => void submit()}>Empiler</button>
      </div>
    </div> : null}
  </div>
}
