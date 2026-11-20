import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { FleetItem, UnreadConversation, ViewedConversation } from './types'
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

export type BoardTab = 'activity' | 'viewed'

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

function moveRowFocus(root: HTMLElement | null, event: ReactKeyboardEvent) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  const rows = [...root?.querySelectorAll<HTMLButtonElement>('.activity-board-row') ?? []]
  if (rows.length === 0) return
  event.preventDefault()
  const index = rows.indexOf(document.activeElement as HTMLButtonElement)
  const next = event.key === 'ArrowDown'
    ? (index < 0 ? 0 : Math.min(index + 1, rows.length - 1))
    : (index < 0 ? rows.length - 1 : Math.max(index - 1, 0))
  rows[next]!.focus()
}

export function FleetIsland({ items, unread, recent, recentError = false, open, requestedTab = null, switchIndex = null, onOpenChange, onRecentRefresh, onOpenRunning, onOpenUnread, onOpenViewed, onReadAll }: {
  items: FleetItem[]
  unread: UnreadConversation[]
  recent: ViewedConversation[] | null
  recentError?: boolean
  open: boolean
  requestedTab?: BoardTab | null
  switchIndex?: number | null
  onOpenChange: (open: boolean) => void
  onRecentRefresh?: () => void
  onOpenRunning: (item: FleetItem) => void
  onOpenUnread: (item: UnreadConversation) => void
  onOpenViewed: (item: ViewedConversation) => void
  onReadAll: () => Promise<void>
}) {
  const [readingAll, setReadingAll] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const pillRef = useRef<HTMLButtonElement>(null)
  const [position, setPosition] = useState<CSSProperties | null>(null)
  const [chosenTab, setChosenTab] = useState<BoardTab>('activity')
  const openKey = open ? `open:${requestedTab ?? ''}` : 'closed'
  const [previousOpenKey, setPreviousOpenKey] = useState(openKey)
  const [focusFirstRow, setFocusFirstRow] = useState(false)
  const now = useNow(1000)
  const lead = items[0]
  const busy = items.length > 0 || unread.length > 0
  const switching = switchIndex !== null
  const boardOpen = open || switching
  const tab = switching ? 'viewed' : chosenTab

  if (openKey !== previousOpenKey) {
    setPreviousOpenKey(openKey)
    if (open) {
      setChosenTab(requestedTab ?? (busy ? 'activity' : 'viewed'))
      setFocusFirstRow(requestedTab !== null)
    }
  }

  useLayoutEffect(() => {
    if (!boardOpen || pillRef.current === null) return setPosition(null)
    const box = pillRef.current.getBoundingClientRect()
    const centered = box.left + box.width / 2 - BOARD_WIDTH / 2
    setPosition({ left: Math.max(8, Math.min(centered, window.innerWidth - BOARD_WIDTH - 8)), top: box.bottom + 8 })
  }, [boardOpen, busy])

  useEffect(() => {
    if (boardOpen && tab === 'viewed') onRecentRefresh?.()
  }, [boardOpen, tab, onRecentRefresh])

  useEffect(() => {
    if (!open || !focusFirstRow) return
    const firstRow = rootRef.current?.querySelector<HTMLButtonElement>('.activity-board-row')
    if (!firstRow) return
    setFocusFirstRow(false)
    firstRow.focus()
  }, [open, focusFirstRow, position, recent])

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

  return (
    <div className="fleet-island-wrap" ref={rootRef} onKeyDown={open && !switching ? (event) => moveRowFocus(rootRef.current, event) : undefined}>
      <button
        ref={pillRef}
        type="button"
        className={`fleet-island${lead ? '' : busy ? ' is-idle' : ' is-quiet'}`}
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Activité : en cours, à lire et lues récemment (Ctrl Maj L) · Ctrl Tab : conversation précédente, Ctrl maintenu pour parcourir"
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
      {boardOpen && position ? (
        <div className="activity-board" role="dialog" aria-label="Activité" style={position}>
          <div className="activity-board-tabs" role="tablist" aria-label="Afficher">
            <button type="button" role="tab" aria-selected={tab === 'activity'} onClick={() => setChosenTab('activity')}>
              Activité{busy ? <span>{items.length + unread.length}</span> : null}
            </button>
            <button type="button" role="tab" aria-selected={tab === 'viewed'} onClick={() => setChosenTab('viewed')} title="Ctrl Maj L">
              Lues récemment
            </button>
          </div>
          {tab === 'viewed' ? (
            <section className="activity-board-section" aria-label="Lues récemment">
              {recent === null ? <p className="activity-board-empty">{recentError ? 'Historique indisponible.' : 'Chargement…'}</p>
                : recent.length === 0 ? <p className="activity-board-empty">Aucune autre conversation lue.</p>
                : recent.map((item, index) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`activity-board-row${index === switchIndex ? ' is-switch-target' : ''}`}
                    aria-current={index === switchIndex ? 'true' : undefined}
                    onClick={() => { onOpenChange(false); onOpenViewed(item) }}
                  >
                    <ProviderMark provider={item.provider} className="activity-board-provider" />
                    <span className="activity-board-text">
                      <strong>{item.title}</strong>
                      <span className="activity-board-meta">
                        {item.project_name ? <span className="activity-board-viewed-project">{item.project_name}</span> : null}
                        {runningIds.has(item.id) ? <span className="activity-board-viewed-state is-running">en cours</span>
                          : unreadIds.has(item.id) ? <span className="activity-board-viewed-state is-unread">nouvelle réponse</span> : null}
                        {item.summary && item.summary !== item.title ? <> · {item.summary}</> : null}
                      </span>
                    </span>
                    <span className="activity-board-time">il y a {since(item.viewed_at, now)}</span>
                  </button>
                ))}
              {switching ? <p className="activity-board-hint"><kbd>Tab</kbd> suivante · relâcher <kbd>Ctrl</kbd> pour ouvrir · <kbd>Échap</kbd> annuler</p> : null}
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
