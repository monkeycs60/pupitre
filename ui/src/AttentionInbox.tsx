import type { AttentionItem, AttentionTarget } from './types'

interface AttentionInboxProps {
  items: AttentionItem[]
  loading: boolean
  error: string | null
  projectName?: string | null
  onOpen: (target: AttentionTarget) => void
  onAcknowledge: (id: string) => Promise<void>
}

const TYPE_LABEL: Record<string, string> = {
  'problem-axis': 'PROBLÉMATIQUE',
  'turn-error': 'TOUR',
  routine: 'ROUTINE',
  guardian: 'GARDIEN',
  sentry: 'SENTRY',
  pipeline: 'PIPELINE',
}

export function AttentionInbox({ items, loading, error, projectName, onOpen, onAcknowledge }: AttentionInboxProps) {
  return (
    <section className="attention-view" aria-labelledby="attention-title">
      <header className="attention-header">
        <div><h1 id="attention-title">Inbox</h1><p>{projectName ? `Ce qui réclame une action dans ${projectName}.` : 'Ce qui réclame une action, tous projets confondus.'}</p></div>
        <span className="attention-count">{items.length}</span>
      </header>
      {error ? <div className="attention-error" role="alert">{error}</div> : null}
      {loading && items.length === 0 ? <div className="attention-empty">Chargement…</div> : null}
      {!loading && items.length === 0 ? <div className="attention-empty"><strong>Rien à traiter</strong><p>Les validations, interruptions et échecs apparaîtront ici.</p></div> : null}
      <div className="attention-list">
        {items.map((item) => (
          <article className={`attention-card is-${item.severity}`} key={item.id}>
            <div className="attention-card-copy">
              <span>{TYPE_LABEL[item.type] ?? item.type.toUpperCase()}</span>
              <h2>{item.title}</h2>
              <p>{item.body}</p>
            </div>
            <div className="attention-card-actions">
              <button type="button" className="secondary-button" onClick={() => onOpen(item.target)}>Ouvrir</button>
              <button type="button" className="text-button" onClick={() => void onAcknowledge(item.id)}>Traité</button>
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}
