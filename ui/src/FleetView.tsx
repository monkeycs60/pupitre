import { useState } from 'react'
import { useFleet, type FleetHistoryItem } from './useFleet'
import { useNow } from './useNow'
import type { FleetItem } from './types'

interface FleetViewProps {
  onConversationSelect: (projectId: string, conversationId: string) => void
}

const KIND_LABEL = {
  turn: 'Tour',
  subtask: 'Sous-tâche',
  routine: 'Routine',
} as const

function elapsed(startedAt: string, endAt: number): string {
  const started = new Date(startedAt).getTime()
  if (!Number.isFinite(started) || !Number.isFinite(endAt)) return 'durée inconnue'
  const seconds = Math.max(0, Math.floor((endAt - started) / 1_000))
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes} min ${String(seconds % 60).padStart(2, '0')} s`
}

function observedAt(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return 'heure inconnue'
  return date.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })
}

type FleetTab = 'active' | 'pending' | 'recent'

const TAB_LABEL: Record<FleetTab, string> = {
  active: 'Actifs',
  pending: 'À traiter',
  recent: 'Récemment terminés',
}

function isHistoryItem(item: FleetItem | FleetHistoryItem): item is FleetHistoryItem {
  return 'leftActiveAt' in item
}

export function FleetView({ onConversationSelect }: FleetViewProps) {
  const { items, history, connected, markAsHandled } = useFleet()
  const [tab, setTab] = useState<FleetTab>('active')
  const now = useNow(1_000)
  const pending = history.filter((item) => item.needsAttention)
  const visibleItems: FleetItem[] | FleetHistoryItem[] = tab === 'active'
    ? items
    : tab === 'pending'
      ? pending
      : history
  const historical = tab !== 'active'

  function openConversation(item: FleetItem | FleetHistoryItem) {
    if (isHistoryItem(item)) markAsHandled(item.id)
    onConversationSelect(item.projectId, item.conversationId)
  }

  const emptyCopy: Record<FleetTab, { title: string; body: string }> = {
    active: {
      title: 'Aucun run actif',
      body: 'Les tours, sous-tâches déléguées et routines apparaîtront ici dès leur lancement.',
    },
    pending: {
      title: 'Rien à traiter',
      body: 'Les runs sortis du flux actif apparaîtront ici jusqu’à l’ouverture de leur conversation.',
    },
    recent: {
      title: 'Aucun run récent',
      body: 'Un historique local court apparaîtra ici quand un run quittera le flux actif.',
    },
  }

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

      <nav className="fleet-tabs" aria-label="Filtrer les runs Fleet" role="tablist">
        {(Object.keys(TAB_LABEL) as FleetTab[]).map((tabId) => {
          const count = tabId === 'active' ? items.length : tabId === 'pending' ? pending.length : history.length
          return (
            <button
              type="button"
              role="tab"
              aria-selected={tab === tabId}
              className={`fleet-tab${tab === tabId ? ' is-selected' : ''}`}
              key={tabId}
              onClick={() => setTab(tabId)}
            >
              <span>{TAB_LABEL[tabId]}</span>
              <span className="fleet-tab-count">{count}</span>
            </button>
          )
        })}
      </nav>

      {visibleItems.length === 0 ? (
        <div className="fleet-empty">
          <strong>{emptyCopy[tab].title}</strong>
          <p>{emptyCopy[tab].body}</p>
        </div>
      ) : (
        <div className="fleet-grid" aria-live="polite">
          {visibleItems.map((item) => (
            <article
              className={`fleet-cell is-${item.kind}${historical ? ' is-history' : ''}${isHistoryItem(item) && item.needsAttention ? ' is-attention' : ''}`}
              key={item.id}
            >
              <header>
                <span className="fleet-kind">{KIND_LABEL[item.kind]}</span>
                <span className={`fleet-status${historical ? ' is-known' : ' is-active'}`}>
                  {historical ? 'terminé / dernier état connu' : 'en cours'}
                </span>
                <span className="fleet-duration">
                  {elapsed(item.startedAt, isHistoryItem(item) ? new Date(item.leftActiveAt).getTime() : now)}
                </span>
              </header>
              <h2>{item.title}</h2>
              <p className="fleet-project">{item.projectName}</p>
              <dl>
                <div><dt>Modèle</dt><dd>{item.provider} · {item.model}</dd></div>
                <div><dt>{historical ? 'Dernier état connu' : 'Dernier événement'}</dt><dd>{item.lastEvent}</dd></div>
                {isHistoryItem(item) ? <div><dt>Sorti du flux</dt><dd>{observedAt(item.leftActiveAt)}</dd></div> : null}
              </dl>
              {historical ? <p className="fleet-known-limit">Le backend ne fournit pas de résultat final pour ce run.</p> : null}
              <button type="button" className="text-button" onClick={() => openConversation(item)}>
                Rejoindre la conversation
              </button>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}
