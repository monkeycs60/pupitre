import { ProjectDevlog } from './ProjectDevlog'
import { ProjectResume } from './ProjectResume'
import { useEffect, useRef, useState } from 'react'
import { launchRequest } from './api'
import type { Project } from './types'
import { absoluteCodeDate, relativeCodeDate } from './codeFormat'

type Chantier = {
  id: string
  key: string
  title: string
  archived_at: string | null
  payload: { description?: string }
  conversation_count?: number
  last_activity_at?: string
  closes_at?: string | null
}
export function chantierMeta(item: Chantier, now = Date.now()) {
  const count = item.conversation_count ?? 0
  const parts = [`${count} conversation${count > 1 ? 's' : ''}`]
  if (item.archived_at) parts.push(`fermé ${relativeCodeDate(item.archived_at, now)}`)
  else if (item.last_activity_at) parts.push(`actif ${relativeCodeDate(item.last_activity_at, now)}`)
  const left = item.closes_at ? Math.ceil((Date.parse(item.closes_at) - now) / 86400000) : null
  const closing = left !== null && left <= 2
    ? left <= 0 ? 'se ferme à la prochaine passe' : `se ferme dans ${left} j`
    : null
  return { text: parts.join(' · '), closing }
}
function ChantierForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: { title: string; description: string }
  submitLabel: string
  onSubmit: (value: { title: string; description: string }) => void
  onCancel: () => void
}) {
  const [title, setTitle] = useState(initial.title)
  const [description, setDescription] = useState(initial.description)
  return (
    <form
      className="chantier-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (title.trim()) onSubmit({ title, description })
      }}
    >
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Titre du chantier"
        aria-label="Titre du chantier"
      />
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description (facultative)"
        aria-label="Description"
        rows={2}
      />
      <div className="chantier-form-actions">
        <button type="button" className="secondary-button" onClick={onCancel}>
          Annuler
        </button>
        <button type="submit" className="primary-button" disabled={!title.trim()}>
          {submitLabel}
        </button>
      </div>
    </form>
  )
}
function ChantierMenu({
  item,
  others,
  onEdit,
  onChange,
}: {
  item: Chantier
  others: Chantier[]
  onEdit: () => void
  onChange: (body: unknown) => void
}) {
  const [open, setOpen] = useState(false)
  const [merging, setMerging] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  const pick = (body: unknown) => {
    setOpen(false)
    onChange(body)
  }
  return (
    <div className="chantier-chip-wrap" ref={ref}>
      <button
        type="button"
        className="chantier-card-more"
        aria-label={`Actions du chantier ${item.title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setMerging(false)
          setOpen(!open)
        }}
      >
        ⋯
      </button>
      {open && (
        <div className="conversation-actions-menu chantier-menu" role="menu">
          {merging ? (
            <>
              <span className="chantier-menu-label">Fusionner dans…</span>
              {others.map((other) => (
                <button
                  type="button"
                  role="menuitem"
                  key={other.id}
                  onClick={() => pick({ mergeInto: other.id })}
                >
                  ◇ {other.title}
                </button>
              ))}
            </>
          ) : (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false)
                  onEdit()
                }}
              >
                Modifier
              </button>
              {others.length > 0 && (
                <button type="button" role="menuitem" onClick={() => setMerging(true)}>
                  Fusionner dans…
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                onClick={() => pick({ closed: !item.archived_at })}
              >
                {item.archived_at ? 'Rouvrir' : 'Fermer le chantier'}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
export function ChantiersView({
  project,
  onStartConversation,
}: {
  project: Project
  onStartConversation: (seed: {
    ticketId: string
    ticketKey: string
    branch: null
  }) => void
}) {
  const [items, setItems] = useState<Chantier[]>([])
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const base = `/api/projects/${project.id}/chantiers`
  async function load() {
    try {
      setItems(await launchRequest<Chantier[]>(base))
      setError('')
    } catch (error) {
      setError(String(error))
    }
  }
  useEffect(() => {
    void load()
  }, [base])
  async function send(path: string, method: string, body: unknown) {
    try {
      await launchRequest(`${base}${path}`, method, body)
      setEditing(null)
      await load()
    } catch (error) {
      setError(String(error))
    }
  }
  const open = items.filter((x) => !x.archived_at)
  const closed = items.filter((x) => x.archived_at)
  const render = (item: Chantier) =>
    editing === item.id ? (
      <li className="chantier-card" key={item.id}>
        <ChantierForm
          initial={{ title: item.title, description: item.payload.description ?? '' }}
          submitLabel="Enregistrer"
          onSubmit={(value) => void send(`/${item.id}`, 'PUT', value)}
          onCancel={() => setEditing(null)}
        />
      </li>
    ) : (
      <li className={`chantier-card${item.archived_at ? ' is-closed' : ''}`} key={item.id}>
        <div className="chantier-card-main">
          <div className="chantier-card-title">
            <span aria-hidden="true">◇</span>
            <strong>{item.title}</strong>
            <span className="chantier-card-key">{item.key}</span>
          </div>
          {item.payload.description ? <p>{item.payload.description}</p> : null}
          {(() => {
            const meta = chantierMeta(item)
            return (
              <div className="chantier-card-meta" title={item.closes_at ? `Fermeture automatique le ${absoluteCodeDate(item.closes_at)}` : undefined}>
                {meta.text}
                {meta.closing ? <span className="chantier-card-closing"> · {meta.closing}</span> : null}
              </div>
            )
          })()}
        </div>
        <button
          type="button"
          className="secondary-button"
          onClick={() =>
            onStartConversation({ ticketId: item.id, ticketKey: item.key, branch: null })
          }
        >
          Reprendre
        </button>
        <ChantierMenu
          item={item}
          others={open.filter((x) => x.id !== item.id)}
          onEdit={() => setEditing(item.id)}
          onChange={(body) => void send(`/${item.id}`, 'PUT', body)}
        />
      </li>
    )
  return (
    <section aria-label="Chantiers" className="chantiers-view">
      <ProjectResume
        projectId={project.id}
        onResume={(ticketId, ticketKey) =>
          onStartConversation({ ticketId, ticketKey, branch: null })
        }
      />
      <div className="chantiers-heading">
        <h2>
          Chantiers <span>{open.length}</span>
        </h2>
        {editing !== 'new' && (
          <button type="button" className="secondary-button" onClick={() => setEditing('new')}>
            + Nouveau
          </button>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      <ul className="chantier-list">
        {editing === 'new' && (
          <li className="chantier-card">
            <ChantierForm
              initial={{ title: '', description: '' }}
              submitLabel="Créer le chantier"
              onSubmit={(value) => void send('', 'POST', value)}
              onCancel={() => setEditing(null)}
            />
          </li>
        )}
        {open.map(render)}
        {open.length === 0 && editing !== 'new' ? (
          <li className="chantier-empty">Aucun chantier ouvert.</li>
        ) : null}
      </ul>
      {closed.length > 0 && (
        <details className="chantiers-closed">
          <summary>Chantiers fermés ({closed.length})</summary>
          <ul className="chantier-list">{closed.map(render)}</ul>
        </details>
      )}
      <ProjectDevlog projectId={project.id} />
    </section>
  )
}
export function ChantierAssignment({
  projectId,
  conversationId,
  label,
  onChange,
}: {
  projectId: string
  conversationId: string
  label: string | null
  onChange: (chantier: { id: string; key: string; title: string } | null) => void
}) {
  const [items, setItems] = useState<Chantier[]>([])
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const [title, setTitle] = useState('')
  async function toggle() {
    if (open) return setOpen(false)
    try {
      setItems(
        await launchRequest<Chantier[]>(`/api/projects/${projectId}/chantiers`),
      )
      setError('')
      setOpen(true)
    } catch (error) {
      setError(String(error))
    }
  }
  async function assign(id: string | null) {
    try {
      await launchRequest(
        `/api/projects/${projectId}/chantiers${id ? `/${id}` : ''}`,
        'PUT',
        { conversationId, ...(id ? {} : { automatic: true }) },
      )
      onChange(items.find((item) => item.id === id) ?? null)
      setOpen(false)
    } catch (error) {
      setError(String(error))
    }
  }
  async function create() {
    try {
      const item = await launchRequest<Chantier>(
        `/api/projects/${projectId}/chantiers`,
        'POST',
        { title, conversationId },
      )
      onChange(item)
      setTitle('')
      setOpen(false)
    } catch (error) {
      setError(String(error))
    }
  }
  return (
    <div className="chantier-chip-wrap">
      <button
        type="button"
        className={`chantier-chip${label ? '' : ' is-empty'}`}
        onClick={() => void toggle()}
        aria-expanded={open}
        aria-haspopup="menu"
        title={error || 'Changer le chantier de cette conversation'}
      >
        <span aria-hidden="true">◇</span>
        {label ?? 'Sans chantier'}
      </button>
      {open && (
        <div className="conversation-actions-menu chantier-menu" role="menu">
          <button type="button" role="menuitem" onClick={() => void assign(null)}>
            Automatique
          </button>
          {items
            .filter((item) => !item.archived_at)
            .map((item) => (
              <button
                type="button"
                role="menuitem"
                key={item.id}
                onClick={() => void assign(item.id)}
              >
                ◇ {item.title}
              </button>
            ))}
          <form
            onSubmit={(event) => {
              event.preventDefault()
              if (title.trim()) void create()
            }}
          >
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Nouveau chantier…"
              aria-label="Nouveau chantier"
            />
          </form>
        </div>
      )}
    </div>
  )
}
