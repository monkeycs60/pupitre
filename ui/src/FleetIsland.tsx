import { useEffect, useRef, useState } from 'react'
import type { FleetItem } from './types'
import { ProviderMark } from './ProviderMark'
import { useNow } from './useNow'
import { formatShortDuration } from './formatActiveDuration'

const KIND_LABELS: Record<FleetItem['kind'], string> = {
  turn: 'Tour',
  subtask: 'Agent délégué',
  routine: 'Routine',
}

function elapsedOf(item: FleetItem, now: number): string {
  const startedAt = Date.parse(item.startedAt)
  return Number.isNaN(startedAt) ? '' : formatShortDuration(now - startedAt)
}

export function FleetIsland({ items, onOpen }: {
  items: FleetItem[]
  onOpen: (item: FleetItem) => void
}) {
  const [menuAt, setMenuAt] = useState<{ left: number; top: number } | null>(null)
  const open = menuAt !== null
  const rootRef = useRef<HTMLDivElement>(null)
  const now = useNow(1000)
  const lead = items[0]

  useEffect(() => {
    if (!open) return
    function handlePointer(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setMenuAt(null)
    }
    document.addEventListener('pointerdown', handlePointer)
    return () => document.removeEventListener('pointerdown', handlePointer)
  }, [open])

  if (lead === undefined) return null
  const others = items.length - 1

  return (
    <div className="fleet-island-wrap" ref={rootRef}>
      <button
        type="button"
        className="fleet-island"
        onClick={(event) => {
          if (items.length === 1) return onOpen(lead)
          const box = event.currentTarget.getBoundingClientRect()
          setMenuAt(open ? null : { left: Math.max(8, box.right - 320), top: box.bottom + 6 })
        }}
        aria-expanded={items.length > 1 ? open : undefined}
        title={items.length === 1 ? `Ouvrir « ${lead.title} »` : `${items.length} exécutions en cours`}
      >
        <span className="fleet-island-dot" aria-hidden="true" />
        <ProviderMark provider={lead.provider} className="fleet-island-provider" />
        <span className="fleet-island-title">{lead.title}</span>
        <span className="fleet-island-time">{elapsedOf(lead, now)}</span>
        {others > 0 ? <span className="fleet-island-more">+{others}</span> : null}
      </button>
      {menuAt !== null && items.length > 1 ? (
        <div className="fleet-island-menu" role="menu" aria-label="Exécutions en cours" style={menuAt}>
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className="fleet-island-item"
              onClick={() => {
                setMenuAt(null)
                onOpen(item)
              }}
            >
              <ProviderMark provider={item.provider} className="fleet-island-provider" />
              <span className="fleet-island-item-text">
                <strong>{item.title}</strong>
                <span>{KIND_LABELS[item.kind]} · {item.projectName}</span>
              </span>
              <span className="fleet-island-time">{elapsedOf(item, now)}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
