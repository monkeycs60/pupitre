import { useMemo, useState } from 'react'
import { useFleet, type FleetHistoryItem } from './useFleet'
import { useNow } from './useNow'
import type { FleetItem } from './types'

interface FleetViewProps {
  onConversationSelect: (projectId: string, conversationId: string) => void
}

const KIND_BADGE = {
  turn: 'TOUR',
  subtask: 'SUB-AGENT',
  routine: 'ROUTINE',
  review: 'REVIEW',
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

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '??'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

type FleetTab = 'active' | 'recent'

const TAB_LABEL: Record<FleetTab, string> = {
  active: 'Actifs',
  recent: 'Historique',
}

function isHistoryItem(item: FleetItem | FleetHistoryItem): item is FleetHistoryItem {
  return 'leftActiveAt' in item
}

interface FleetGroup {
  projectId: string
  projectName: string
  items: (FleetItem | FleetHistoryItem)[]
}

function groupByProject(items: (FleetItem | FleetHistoryItem)[]): FleetGroup[] {
  const order: string[] = []
  const byProject = new Map<string, FleetGroup>()
  for (const item of items) {
    let group = byProject.get(item.projectId)
    if (!group) {
      group = { projectId: item.projectId, projectName: item.projectName, items: [] }
      byProject.set(item.projectId, group)
      order.push(item.projectId)
    }
    group.items.push(item)
  }
  return order.map((id) => byProject.get(id)!)
}

export function FleetView({ onConversationSelect }: FleetViewProps) {
  const { items, history, connected } = useFleet()
  const [tab, setTab] = useState<FleetTab>('active')
  const now = useNow(1_000)
  const visibleItems: FleetItem[] | FleetHistoryItem[] = tab === 'active'
    ? items
    : history
  const historical = tab !== 'active'
  const groups = useMemo(() => groupByProject(visibleItems), [visibleItems])

  const counters = useMemo(() => {
    const projectIds = new Set(items.map((item) => item.projectId))
    return [
      { key: 'turn', label: 'Tours actifs', value: items.filter((item) => item.kind === 'turn').length, color: 'accent' as const },
      { key: 'subtask', label: 'Sub-agents', value: items.filter((item) => item.kind === 'subtask').length, color: 'warn' as const },
      { key: 'routine', label: 'Routines', value: items.filter((item) => item.kind === 'routine').length, color: 'ok' as const },
      { key: 'review', label: 'Reviews', value: items.filter((item) => item.kind === 'review').length, color: 'warn' as const },
      { key: 'projects', label: 'Projets', value: projectIds.size, color: 'muted' as const },
    ]
  }, [items])

  function openConversation(item: FleetItem | FleetHistoryItem) {
    onConversationSelect(item.projectId, item.conversationId)
  }

  const emptyCopy: Record<FleetTab, { title: string; body: string }> = {
    active: {
      title: 'Aucun run actif',
      body: 'Les tours, sous-tâches, reviews et routines apparaîtront ici dès leur lancement.',
    },
    recent: {
      title: 'Aucun run récent',
      body: 'Un historique local court apparaîtra ici quand un run quittera le flux actif.',
    },
  }

  return (
    <section className="fleet-view" aria-labelledby="fleet-title">
      <div className="fleet-scroll">
        <header className="fleet-header">
          <div className="fleet-heading">
            <h1 id="fleet-title">Fleet</h1>
            <p>
              Tout ce qui tourne, sur tous les projets, en direct.
              {' '}
              <span className={`fleet-connection ${connected ? 'is-live' : ''}`}>
                <i aria-hidden="true" /> {connected ? 'temps réel' : 'reconnexion'}
              </span>
            </p>
          </div>
          <div className="fleet-counters">
            {counters.map((counter) => (
              <div className={`fleet-counter is-${counter.color}`} key={counter.key}>
                <div className="fleet-counter-label">
                  <span className="fleet-counter-dot" aria-hidden="true" />
                  <span>{counter.label}</span>
                </div>
                <div className="fleet-counter-value">{counter.value}</div>
              </div>
            ))}
          </div>
        </header>

        <nav className="fleet-tabs" aria-label="Filtrer les runs Fleet" role="tablist">
          {(Object.keys(TAB_LABEL) as FleetTab[]).map((tabId) => {
            const count = tabId === 'active' ? items.length : history.length
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
          groups.map((group) => (
            <section className="fleet-group" key={group.projectId} aria-label={group.projectName}>
              <div className="fleet-group-header">
                <span className="fleet-group-chip">{initials(group.projectName)}</span>
                <span className="fleet-group-name">{group.projectName}</span>
                <span className="fleet-group-rule" aria-hidden="true" />
                <span className="fleet-group-meta">
                  {group.items.length} {group.items.length > 1 ? (historical ? 'entrées' : 'en cours') : (historical ? 'entrée' : 'en cours')}
                </span>
              </div>
              <div className="fleet-cards">
                {group.items.map((item) => (
                  <article
                    className={`fleet-card is-${item.kind}${historical ? ' is-history' : ''}`}
                    key={item.id}
                  >
                    <div className="fleet-card-top">
                      <span className="fleet-card-kind">{KIND_BADGE[item.kind]}</span>
                      <span className="fleet-card-elapsed">
                        {elapsed(item.startedAt, isHistoryItem(item) ? new Date(item.leftActiveAt).getTime() : now)}
                      </span>
                      <span className="fleet-card-dot" aria-hidden="true" />
                    </div>
                    <h2 className="fleet-card-title">{item.title}</h2>
                    <p className="fleet-card-model">{item.provider} · {item.model}</p>
                    <div className="fleet-card-bar"><span /></div>
                    <div className="fleet-card-foot">
                      <span className="fleet-card-last">
                        {isHistoryItem(item) ? `Sorti du flux ${observedAt(item.leftActiveAt)}` : item.lastEvent}
                      </span>
                      <button type="button" className="fleet-card-open" onClick={() => openConversation(item)}>
                        Ouvrir →
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </section>
  )
}
