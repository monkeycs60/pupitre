import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent } from 'react'
import { Icon } from './Icon'
import type { Note, NoteScope } from './types'
import { useConversationNotes, type NotesApi } from './useConversationNotes'

interface ConversationNotesChipProps {
  conversationId: string
  projectId: string
  ticketId: string | null
}

export function ConversationNotesChip({ conversationId, projectId, ticketId }: ConversationNotesChipProps) {
  const notesApi = useConversationNotes(conversationId, projectId, ticketId)
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<CSSProperties>({})
  const rootRef = useRef<HTMLDivElement>(null)
  const openCount = notesApi.notes.filter((note) => note.done_at === null).length

  useEffect(() => {
    if (!open) return
    function handlePointer(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    function handleKey(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', handlePointer)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('pointerdown', handlePointer)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open])

  function toggle() {
    const header = rootRef.current?.closest('.conversation-header')
    const button = rootRef.current?.firstElementChild
    if (!open && header && button) {
      const frame = header.getBoundingClientRect()
      const chip = button.getBoundingClientRect()
      setAnchor({
        '--notes-anchor-left': `${chip.left - frame.left}px`,
        '--notes-anchor-top': `${chip.bottom - frame.top + 6}px`,
      } as CSSProperties)
    }
    setOpen((current) => !current)
  }

  const label = openCount === 0
    ? 'Notes avant déploiement : aucune note ouverte'
    : `Notes avant déploiement : ${openCount} note${openCount > 1 ? 's' : ''} ouverte${openCount > 1 ? 's' : ''}`

  return (
    <div className="notes-chip-root" ref={rootRef}>
      <button
        type="button"
        className={`notes-chip${openCount > 0 ? ' has-notes' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={toggle}
      >
        <Icon name="pin" size={12} />
        {openCount > 0 ? <span className="notes-chip-count">{openCount}</span> : <span>Notes</span>}
      </button>
      {open ? (
        <NotesPopover notesApi={notesApi} style={anchor} />
      ) : null}
    </div>
  )
}

function NotesPopover({ notesApi, style }: { notesApi: NotesApi; style: CSSProperties }) {
  const { ticket, notes } = notesApi
  const [scope, setScope] = useState<NoteScope | null>(null)
  const [draft, setDraft] = useState('')
  const [showDone, setShowDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const effectiveScope: NoteScope = ticket ? scope ?? 'ticket' : 'project'
  const ticketNotes = notes.filter((note) => note.done_at === null && note.ticket_id !== null)
  const projectNotes = notes.filter((note) => note.done_at === null && note.ticket_id === null)
  const doneNotes = notes.filter((note) => note.done_at !== null)
    .sort((left, right) => (right.done_at ?? '').localeCompare(left.done_at ?? ''))

  async function run(action: () => Promise<void>) {
    setError(null)
    try {
      await action()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'action impossible')
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    const body = draft.trim()
    if (!body) return
    void run(async () => {
      await notesApi.add(body, effectiveScope)
      setDraft('')
    })
  }

  return (
    <div className="notes-popover" role="dialog" aria-label="Notes avant déploiement" style={style}>
      <div className="notes-popover-body">
        {ticketNotes.length === 0 && projectNotes.length === 0 ? (
          <p className="notes-empty">Aucune note ouverte. Notez ici ce qu'il ne faut pas oublier avant le déploiement.</p>
        ) : null}
        {ticket && ticketNotes.length > 0 ? (
          <NotesSection title={`Ticket ${ticket.key}`} notes={ticketNotes} notesApi={notesApi} run={run} />
        ) : null}
        {projectNotes.length > 0 ? (
          <NotesSection title="Projet" notes={projectNotes} notesApi={notesApi} run={run} />
        ) : null}
        {doneNotes.length > 0 ? (
          <section className="notes-section notes-done">
            <button
              type="button"
              className="notes-done-toggle"
              aria-expanded={showDone}
              onClick={() => setShowDone((current) => !current)}
            >
              <Icon name={showDone ? 'chevron-down' : 'chevron-right'} size={12} />
              Faites ({doneNotes.length})
            </button>
            {showDone ? (
              <ul className="notes-list">
                {doneNotes.map((note) => <NoteRow key={note.id} note={note} notesApi={notesApi} run={run} />)}
              </ul>
            ) : null}
          </section>
        ) : null}
      </div>
      {error ? <p className="notes-error" role="alert">{error}</p> : null}
      <form className="notes-add" onSubmit={submit}>
        {ticket ? (
          <div className="notes-scope" role="group" aria-label="Portée de la note">
            <button type="button" className={effectiveScope === 'ticket' ? 'is-active' : ''} aria-pressed={effectiveScope === 'ticket'} onClick={() => setScope('ticket')}>Ticket</button>
            <button type="button" className={effectiveScope === 'project' ? 'is-active' : ''} aria-pressed={effectiveScope === 'project'} onClick={() => setScope('project')}>Projet</button>
          </div>
        ) : null}
        <input
          className="notes-add-input"
          value={draft}
          maxLength={500}
          placeholder="Ajouter une note…"
          aria-label={effectiveScope === 'ticket' && ticket ? `Ajouter une note au ticket ${ticket.key}` : 'Ajouter une note au projet'}
          autoFocus={!window.matchMedia?.('(pointer: coarse)').matches}
          onChange={(event) => setDraft(event.target.value)}
        />
      </form>
    </div>
  )
}

interface NotesSectionProps {
  title: string
  notes: Note[]
  notesApi: NotesApi
  run: (action: () => Promise<void>) => Promise<void>
}

function NotesSection({ title, notes, notesApi, run }: NotesSectionProps) {
  return (
    <section className="notes-section" aria-label={title}>
      <h3 className="notes-section-title">{title}</h3>
      <ul className="notes-list">
        {notes.map((note) => <NoteRow key={note.id} note={note} notesApi={notesApi} run={run} />)}
      </ul>
    </section>
  )
}

function NoteRow({ note, notesApi, run }: { note: Note; notesApi: NotesApi; run: NotesSectionProps['run'] }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(note.body)
  const done = note.done_at !== null

  function save() {
    const body = draft.trim()
    setEditing(false)
    if (!body || body === note.body) {
      setDraft(note.body)
      return
    }
    void run(() => notesApi.edit(note, body))
  }

  function handleKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault()
      save()
    }
    if (event.key === 'Escape') {
      event.stopPropagation()
      setDraft(note.body)
      setEditing(false)
    }
  }

  return (
    <li className={`note-row${done ? ' is-done' : ''}`}>
      <input
        type="checkbox"
        checked={done}
        aria-label={done ? `Rouvrir : ${note.body}` : `Marquer comme faite : ${note.body}`}
        onChange={(event) => { void run(() => notesApi.setDone(note, event.target.checked)) }}
      />
      {editing ? (
        <input
          className="note-edit"
          value={draft}
          maxLength={500}
          aria-label="Modifier la note"
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKey}
          onBlur={save}
        />
      ) : (
        <button type="button" className="note-text" title="Modifier" onClick={() => setEditing(true)}>
          {note.body.split(/`([^`]+)`/).map((part, index) => index % 2 === 1 ? <code key={index}>{part}</code> : part)}
        </button>
      )}
      {note.author === 'agent' ? <span className="note-agent" title="Ajoutée par l'agent">agent</span> : null}
      <button
        type="button"
        className="note-delete"
        aria-label={`Supprimer : ${note.body}`}
        title="Supprimer"
        onClick={() => { void run(() => notesApi.remove(note)) }}
      >
        <Icon name="trash" size={13} />
      </button>
    </li>
  )
}
