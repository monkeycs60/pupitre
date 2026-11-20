import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import type { FleetItem, UnreadConversation, ViewedConversation } from './types'
import { listViewedConversations } from './api'
import { ProviderMark } from './ProviderMark'
import { useNow } from './useNow'
import { formatShortDuration } from './formatActiveDuration'
import { toolPresentation, type ToolPresentation } from './toolPresentation'

const KIND_LABELS: Record<FleetItem['kind'], string> = {
  turn: 'Tour',
  subtask: 'Agent délégué',
  routine: 'Routine',
}

const BOARD_WIDTH = 440
const VIEWED_LIMIT = 8

type BoardTab = 'activity' | 'viewed'

function since(value: string, now: number): string {
  const at = Date.parse(value)
  return Number.isNaN(at) ? '' : formatShortDuration(now - at)
}

function byProject<T>(items: T[], projectOf: (item: T) => string): Array<[string, T[]]> {
  const groups = new Map<string, T[]>()
  for (const item of items) groups.set(projectOf(item), [...groups.get(projectOf(item)) ?? [], item])
  return [...groups]
}

function toolLine(item: FleetItem): ToolPresentation | null {
  if (!item.lastTool) return null
  return toolPresentation({ kind: 'tool', id: item.id, toolId: item.id, toolName: item.lastTool.toolName, input: item.lastTool.input, images: [] })
}

export function FleetIsland({ items, unread, open, currentConversationId, onOpenChange, onOpenRunning, onOpenUnread, onOpenViewed, onReadAll }: {
  items: FleetItem[]
  unread: UnreadConversation[]
  open: boolean
  currentConversationId?: string | null
  onOpenChange: (open: boolean) => void
  onOpenRunning: (item: FleetItem) => void
  onOpenUnread: (item: UnreadConversation) => void
  onOpenViewed: (item: ViewedConversation) => void
  onReadAll: () => Promise<void>
}) {
  const [readingAll, setReadingAll] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const pillRef = useRef<HTMLButtonElement>(null)
  const [position, setPosition] = useState<CSSProperties | null>(null)
  const [tab, setTab] = useState<BoardTab>('activity')
  const [wasOpen, setWasOpen] = useState(open)
  const [viewed, setViewed] = useState<ViewedConversation[] | null>(null)
  const [viewedError, setViewedError] = useState(false)
  const now = useNow(1000)
  const lead = items[0]
  const busy = items.length > 0 || unread.length > 0

  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setTab(busy ? 'activity' : 'viewed')
  }

  useLayoutEffect(() => {
    if (!open || pillRef.current === null) return setPosition(null)
    const box = pillRef.current.getBoundingClientRect()
    const centered = box.left + box.width / 2 - BOARD_WIDTH / 2
    setPosition({ left: Math.max(8, Math.min(centered, window.innerWidth - BOARD_WIDTH - 8)), top: box.bottom + 8 })
  }, [open, busy])

  useEffect(() => {
    if (!open || tab !== 'viewed') return
    const controller = new AbortController()
    listViewedConversations(VIEWED_LIMIT + 1, controller.signal)
      .then((next) => { setViewed(next); setViewedError(false) })
      .catch(() => { if (!controller.signal.aborted) setViewedError(true) })
    return () => controller.abort()
  }, [open, tab])

  useEffect(() => {
    if (!open) return
    function handlePointer(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) onOpenChange(false)
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onOpenChange(false)
    }
    document.addEventListener('pointerdown', handlePointer)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('pointerdown', handlePointer)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open, onOpenChange])

  const runningIds = new Set(items.map((item) => item.conversationId))
  const unreadIds = new Set(unread.map((item) => item.id))
  const recent = (viewed ?? []).filter((item) => item.id !== currentConversationId).slice(0, VIEWED_LIMIT)

  return (
    <div className="fleet-island-wrap" ref={rootRef}>
      <button
        ref={pillRef}
        type="button"
        className={`fleet-island${lead ? '' : busy ? ' is-idle' : ' is-quiet'}`}
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Activité : en cours, à lire et lues récemment"
      >
        {lead ? (
          <>
            <span className="fleet-island-dot" aria-hidden="true" />
            <ProviderMark provider={lead.provider} className="fleet-island-provider" />
            <span className="fleet-island-title"><strong>{lead.projectName}</strong> · {lead.title}</span>
            <span className="fleet-island-time">{since(lead.startedAt, now)}</span>
          </>
        ) : busy ? <span className="fleet-island-title">Réponses à lire</span> : (
          <>
            <HistoryGlyph />
            <span className="fleet-island-title">Lues récemment</span>
          </>
        )}
        {items.length > 1 ? <span className="fleet-island-badge is-running" title={`${items.length} en cours`}>{items.length}</span> : null}
        {unread.length > 0 ? <span className="fleet-island-badge is-unread" title={`${unread.length} à lire`}>{unread.length}</span> : null}
      </button>
      {open && position ? (
        <div className="activity-board" role="dialog" aria-label="Activité" style={position}>
          <div className="activity-board-tabs" role="tablist" aria-label="Afficher">
            <button type="button" role="tab" aria-selected={tab === 'activity'} onClick={() => setTab('activity')}>
              Activité{busy ? <span>{items.length + unread.length}</span> : null}
            </button>
            <button type="button" role="tab" aria-selected={tab === 'viewed'} onClick={() => setTab('viewed')}>
              Lues récemment
            </button>
          </div>
          {tab === 'viewed' ? (
            <section className="activity-board-section" aria-label="Lues récemment">
              {viewed === null && !viewedError ? <p className="activity-board-empty">Chargement…</p>
                : viewedError && viewed === null ? <p className="activity-board-empty">Historique indisponible.</p>
                : recent.length === 0 ? <p className="activity-board-empty">Aucune autre conversation lue.</p>
                : recent.map((item) => (
                  <button key={item.id} type="button" className="activity-board-row" onClick={() => { onOpenChange(false); onOpenViewed(item) }}>
                    <ProviderMark provider={item.provider} className="activity-board-provider" />
                    <span className="activity-board-text">
                      <strong>{item.title}</strong>
                      <span className="activity-board-meta">
                        <span className="activity-board-viewed-project">{item.project_name}</span>
                        {runningIds.has(item.id) ? <span className="activity-board-viewed-state is-running">en cours</span>
                          : unreadIds.has(item.id) ? <span className="activity-board-viewed-state is-unread">nouvelle réponse</span> : null}
                        {item.summary && item.summary !== item.title ? <> · {item.summary}</> : null}
                      </span>
                    </span>
                    <span className="activity-board-time">il y a {since(item.viewed_at, now)}</span>
                  </button>
                ))}
            </section>
          ) : (
            <>
              <section className="activity-board-section">
                <header>
                  <span className="activity-board-dot is-running" aria-hidden="true" />
                  <h2>En cours</h2>
                  <span className="activity-board-count is-running">{items.length}</span>
                </header>
                {items.length === 0 ? <p className="activity-board-empty">Aucun agent ne travaille.</p> : byProject(items, (item) => item.projectName).map(([project, group]) => (
                  <div key={project} className="activity-board-group">
                    <span className="activity-board-project">{project}{group.length > 1 ? <span className="activity-board-project-count">{group.length}</span> : null}</span>
                    {group.map((item) => {
                      const tool = toolLine(item)
                      return (
                        <button key={item.id} type="button" className="activity-board-row" onClick={() => { onOpenChange(false); onOpenRunning(item) }}>
                          <ProviderMark provider={item.provider} className="activity-board-provider" />
                          <span className="activity-board-text">
                            <strong>{item.title}</strong>
                            {tool ? (
                              <span className={`activity-board-tool is-${tool.category}`} title={tool.detail}>
                                <span className="activity-board-tool-label">{tool.label}</span>
                                {tool.detail ? <span className="activity-board-tool-detail">{tool.detail}</span> : null}
                              </span>
                            ) : <span className="activity-board-meta">{KIND_LABELS[item.kind]} · {item.lastEvent}</span>}
                          </span>
                          <span className="activity-board-time">{since(item.startedAt, now)}</span>
                        </button>
                      )
                    })}
                  </div>
                ))}
              </section>
              <section className="activity-board-section">
                <header>
                  <span className="activity-board-dot is-unread" aria-hidden="true" />
                  <h2>Terminé, à lire</h2>
                  {unread.length > 1 ? (
                    <button type="button" className="activity-board-read-all" disabled={readingAll} onClick={() => {
                      setReadingAll(true)
                      void onReadAll().finally(() => setReadingAll(false))
                    }}>Tout marquer comme lu</button>
                  ) : null}
                  <span className="activity-board-count is-unread">{unread.length}</span>
                </header>
                {unread.length === 0 ? <p className="activity-board-empty">Tout est lu.</p> : byProject(unread, (item) => item.project_name).map(([project, group]) => (
                  <div key={project} className="activity-board-group">
                    <span className="activity-board-project">{project}{group.length > 1 ? <span className="activity-board-project-count">{group.length}</span> : null}</span>
                    {group.map((item) => (
                      <button key={item.id} type="button" className="activity-board-row" onClick={() => { onOpenChange(false); onOpenUnread(item) }}>
                        <ProviderMark provider={item.provider} className="activity-board-provider" />
                        <span className="activity-board-text">
                          <strong>{item.title}</strong>
                          {item.summary ? <span className="activity-board-meta">{item.summary}</span> : null}
                        </span>
                        <span className="activity-board-time">il y a {since(item.updated_at, now)}</span>
                      </button>
                    ))}
                  </div>
                ))}
              </section>
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}

function HistoryGlyph() {
  return (
    <svg className="fleet-island-history" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9" />
      <path d="M2.3 2.6v2.6h2.6" />
      <path d="M8 5.2V8l1.9 1.3" />
    </svg>
  )
}
