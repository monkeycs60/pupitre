import { ProjectDevlog } from './ProjectDevlog'
import { ProjectResume } from './ProjectResume'
import { useEffect, useState } from 'react'
import { launchRequest } from './api'
import type { Project } from './types'

type Chantier = {
  id: string
  key: string
  title: string
  archived_at: string | null
  payload: { description?: string }
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
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
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
  async function change(id: string, body: unknown) {
    try {
      await launchRequest(`${base}/${id}`, 'PUT', body)
      await load()
    } catch (error) {
      setError(String(error))
    }
  }
  async function save() {
    try {
      await launchRequest(
        `${base}${editing ? `/${editing}` : ''}`,
        editing ? 'PUT' : 'POST',
        { title, description },
      )
      setTitle('')
      setDescription('')
      setEditing(null)
      await load()
    } catch (error) {
      setError(String(error))
    }
  }
  const render = (item: Chantier) => (
    <div className="chantier-row" key={item.id}>
      <strong>◇ {item.title}</strong>
      <span>{item.key}</span>
      <p>{item.payload.description}</p>
      <button
        className="secondary-button"
        onClick={() =>
          onStartConversation({
            ticketId: item.id,
            ticketKey: item.key,
            branch: null,
          })
        }
      >
        Reprendre
      </button>
      <button
        className="secondary-button"
        onClick={() => {
          setEditing(item.id)
          setTitle(item.title)
          setDescription(item.payload.description ?? '')
        }}
      >
        Modifier
      </button>
      <button
        className="secondary-button"
        onClick={() => void change(item.id, { closed: !item.archived_at })}
      >
        {item.archived_at ? 'Rouvrir' : 'Fermer le chantier'}
      </button>
      <label>
        Fusionner dans
        <select
          value=""
          onChange={(event) => {
            if (event.target.value)
              void change(item.id, { mergeInto: event.target.value })
          }}
        >
          <option value="">Choisir…</option>
          {items
            .filter((x) => x.id !== item.id)
            .map((x) => (
              <option key={x.id} value={x.id}>
                {x.title}
              </option>
            ))}
        </select>
      </label>
    </div>
  )
  return (
    <section aria-label="Chantiers" className="chantiers-view">
      <ProjectResume
        projectId={project.id}
        onResume={(ticketId, ticketKey) =>
          onStartConversation({ ticketId, ticketKey, branch: null })
        }
      />
      <ProjectDevlog projectId={project.id} />
      {error && <p role="alert">{error}</p>}
      {items.filter((x) => !x.archived_at).map(render)}
      <details>
        <summary>
          Chantiers fermés ({items.filter((x) => x.archived_at).length})
        </summary>
        {items.filter((x) => x.archived_at).map(render)}
      </details>
      <label>
        Titre du chantier
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        Description
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      <button
        className="primary-button"
        disabled={!title.trim()}
        onClick={() => void save()}
      >
        {editing ? 'Enregistrer' : 'Créer un chantier'}
      </button>
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
