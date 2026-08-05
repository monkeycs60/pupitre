import { useEffect, useState } from 'react'
import { useFleet } from './useFleet'

interface FleetViewProps {
  onConversationSelect: (projectId: string, conversationId: string) => void
}

const KIND_LABEL = {
  turn: 'Tour',
  subtask: 'Sous-tâche',
  routine: 'Routine',
} as const

function elapsed(startedAt: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1_000))
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes} min ${String(seconds % 60).padStart(2, '0')} s`
}

export function FleetView({ onConversationSelect }: FleetViewProps) {
  const { items, connected } = useFleet()
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [])

  return (
    <section className="fleet-view" aria-labelledby="fleet-title">
      <header className="fleet-header">
        <div>
          <h1 id="fleet-title">Fleet</h1>
          <p>Tous les modèles en cours, tous projets confondus.</p>
        </div>
        <span className={`fleet-connection ${connected ? 'is-live' : ''}`}>
          <i aria-hidden="true" /> {connected ? 'temps réel' : 'reconnexion'}
        </span>
      </header>

      {items.length === 0 ? (
        <div className="fleet-empty">
          <strong>Aucun run actif</strong>
          <p>Les tours, sous-tâches déléguées et routines apparaîtront ici dès leur lancement.</p>
        </div>
      ) : (
        <div className="fleet-grid" aria-live="polite">
          {items.map((item) => (
            <article className={`fleet-cell is-${item.kind}`} key={item.id}>
              <header>
                <span className="fleet-kind">{KIND_LABEL[item.kind]}</span>
                <span className="fleet-duration">{elapsed(item.startedAt, now)}</span>
              </header>
              <h2>{item.title}</h2>
              <p className="fleet-project">{item.projectName}</p>
              <dl>
                <div><dt>Modèle</dt><dd>{item.provider} · {item.model}</dd></div>
                <div><dt>Dernier événement</dt><dd>{item.lastEvent}</dd></div>
              </dl>
              <button type="button" className="text-button" onClick={() => onConversationSelect(item.projectId, item.conversationId)}>
                Rejoindre la conversation
              </button>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}
