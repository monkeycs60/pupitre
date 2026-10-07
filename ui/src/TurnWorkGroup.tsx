import { useState } from 'react'
import { EventStream } from './EventStream'
import { formatShortDuration } from './formatActiveDuration'
import { toolGroupSummary } from './toolPresentation'
import { turnWorkNoteCount, turnWorkTools, type TurnWorkBlock } from './turnWork'

export function TurnWorkGroup({ work, onImageOpen, onImageLoad }: {
  work: TurnWorkBlock
  onImageOpen: (src: string, alt: string) => void
  onImageLoad: () => void
}) {
  const [open, setOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  const tools = turnWorkTools(work)
  const notes = turnWorkNoteCount(work)
  const failedCount = tools.filter((tool) => tool.output !== undefined && tool.isError === true).length
  const parts = [
    work.durationMs === undefined ? null : formatShortDuration(work.durationMs),
    tools.length > 0 ? toolGroupSummary(tools) : null,
    notes > 0 ? `${notes} ${notes > 1 ? 'messages intermédiaires' : 'message intermédiaire'}` : null,
  ].filter((part) => part !== null)

  return (
    <div className={`tool-activity-group turn-work${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="tool-activity-summary"
        aria-expanded={open}
        onClick={() => {
          setMounted(true)
          setOpen(!open)
        }}
      >
        <span className="tool-activity-chevron" aria-hidden="true" />
        <span>{parts.length > 0 ? parts.join(' · ') : 'Raisonnement'}</span>
        {failedCount > 0 ? <span className="tool-activity-failed">{failedCount} en échec</span> : null}
      </button>
      <div className="tool-activity-body" inert={!open}>
        <div className="tool-activity-list turn-work-list">
          {mounted ? <EventStream blocks={work.blocks} onImageOpen={onImageOpen} onImageLoad={onImageLoad} /> : null}
        </div>
      </div>
    </div>
  )
}
