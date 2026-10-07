import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import type { FleetItem, UnreadConversation } from './types'
import { ProviderMark } from './ProviderMark'
import { useNow } from './useNow'
import { formatShortDuration } from './formatActiveDuration'

const KIND_LABELS: Record<FleetItem['kind'], string> = {
  turn: 'Tour',
  subtask: 'Agent délégué',
  routine: 'Routine',
}

const BOARD_WIDTH = 440

function since(value: string, now: number): string {
  const at = Date.parse(value)
  return Number.isNaN(at) ? '' : formatShortDuration(now - at)
}

export function FleetIsland({ items, unread, open, onOpenChange, onOpenRunning, onOpenUnread }: {
  items: FleetItem[]
  unread: UnreadConversation[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpenRunning: (item: FleetItem) => void
  onOpenUnread: (item: UnreadConversation) => void
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const pillRef = useRef<HTMLButtonElement>(null)
  const [position, setPosition] = useState<CSSProperties | null>(null)
  const now = useNow(1000)
  const lead = items[0]
  const visible = items.length > 0 || unread.length > 0

  useLayoutEffect(() => {
    if (!open || pillRef.current === null) return setPosition(null)
    const box = pillRef.current.getBoundingClientRect()
    const centered = box.left + box.width / 2 - BOARD_WIDTH / 2
    setPosition({ left: Math.max(8, Math.min(centered, window.innerWidth - BOARD_WIDTH - 8)), top: box.bottom + 8 })
  }, [open, visible])

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

  if (!visible) return null

  return (
    <div className="fleet-island-wrap" ref={rootRef}>
      <button
        ref={pillRef}
        type="button"
        className={`fleet-island${lead ? '' : ' is-idle'}`}
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Activité : en cours et à lire"
      >
        {lead ? (
          <>
            <span className="fleet-island-dot" aria-hidden="true" />
            <ProviderMark provider={lead.provider} className="fleet-island-provider" />
            <span className="fleet-island-title"><strong>{lead.projectName}</strong> · {lead.title}</span>
            <span className="fleet-island-time">{since(lead.startedAt, now)}</span>
          </>
        ) : <span className="fleet-island-title">Réponses à lire</span>}
        {items.length > 1 ? <span className="fleet-island-badge is-running" title={`${items.length} en cours`}>{items.length}</span> : null}
        {unread.length > 0 ? <span className="fleet-island-badge is-unread" title={`${unread.length} à lire`}>{unread.length}</span> : null}
      </button>
      {open && position ? (
        <div className="activity-board" role="dialog" aria-label="Activité" style={position}>
          <section className="activity-board-section">
            <header>
              <span className="activity-board-dot is-running" aria-hidden="true" />
              <h2>En cours</h2>
              <span className="activity-board-count is-running">{items.length}</span>
            </header>
            {items.length === 0 ? <p className="activity-board-empty">Aucun agent ne travaille.</p> : items.map((item) => (
              <button key={item.id} type="button" className="activity-board-row" onClick={() => { onOpenChange(false); onOpenRunning(item) }}>
                <ProviderMark provider={item.provider} className="activity-board-provider" />
                <span className="activity-board-text">
                  <span className="activity-board-project">{item.projectName}</span>
                  <strong>{item.title}</strong>
                  <span className="activity-board-meta">{KIND_LABELS[item.kind]} · {item.model}</span>
                </span>
                <span className="activity-board-time">{since(item.startedAt, now)}</span>
              </button>
            ))}
          </section>
          <section className="activity-board-section">
            <header>
              <span className="activity-board-dot is-unread" aria-hidden="true" />
              <h2>Terminé, à lire</h2>
              <span className="activity-board-count is-unread">{unread.length}</span>
            </header>
            {unread.length === 0 ? <p className="activity-board-empty">Tout est lu.</p> : unread.map((item) => (
              <button key={item.id} type="button" className="activity-board-row" onClick={() => { onOpenChange(false); onOpenUnread(item) }}>
                <ProviderMark provider={item.provider} className="activity-board-provider" />
                <span className="activity-board-text">
                  <span className="activity-board-project">{item.project_name}</span>
                  <strong>{item.title}</strong>
                  {item.summary ? <span className="activity-board-meta">{item.summary}</span> : null}
                </span>
                <span className="activity-board-time">il y a {since(item.updated_at, now)}</span>
              </button>
            ))}
          </section>
        </div>
      ) : null}
    </div>
  )
}
