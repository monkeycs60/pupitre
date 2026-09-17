import type { UnreadConversation } from './types'

interface AttentionInboxProps {
  items: UnreadConversation[]
  loading: boolean
  error: string | null
  onOpen: (item: UnreadConversation) => void
}

function updatedAt(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  return date.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })
}

export function AttentionInbox({ items, loading, error, onOpen }: AttentionInboxProps) {
  return (
    <section className="attention-view" aria-labelledby="attention-title">
      <header className="attention-header">
        <div><h1 id="attention-title">Conversations à lire</h1><p>Les réponses terminées que vous n’avez pas encore ouvertes, tous projets confondus.</p></div>
        <span className="attention-count">{items.length}</span>
      </header>
      {error ? <div className="attention-error" role="alert">{error}</div> : null}
      {loading && items.length === 0 ? <div className="attention-empty">Chargement…</div> : null}
      {!loading && items.length === 0 ? <div className="attention-empty"><strong>Tout est lu</strong><p>Les nouvelles réponses apparaîtront ici.</p></div> : null}
      <div className="attention-list">
        {items.map((item) => (
          <button className="attention-card" type="button" key={item.id} onClick={() => onOpen(item)}>
            <span className="attention-unread-dot" aria-hidden="true" />
            <div className="attention-card-copy">
              <h2>{item.title}</h2>
              <p>{item.summary}</p>
              <span className="attention-card-meta">{item.project_name} · {item.provider} · {updatedAt(item.updated_at)}</span>
            </div>
            <span className="attention-open" aria-hidden="true">Ouvrir →</span>
          </button>
        ))}
      </div>
    </section>
  )
}
