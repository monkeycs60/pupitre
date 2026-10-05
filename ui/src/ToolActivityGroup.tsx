import { useState } from 'react'
import type { EventBlock } from './eventBlocks'
import { EventView } from './EventView'

type ToolBlock = Extract<EventBlock, { kind: 'tool' }>

const MAX_PIPS = 8

export function ToolActivityGroup({ tools, live = false, onImageOpen, onImageLoad }: {
  tools: ToolBlock[]
  /** Le groupe appartient au tour en cours. */
  live?: boolean
  onImageOpen: (src: string, alt: string) => void
  onImageLoad: () => void
}) {
  const running = tools.some((tool) => tool.output === undefined)
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const [seenLive, setSeenLive] = useState(live)
  if (live && !seenLive) setSeenLive(true)
  const doneCount = tools.filter((tool) => tool.output !== undefined).length
  const failedCount = tools.filter((tool) => tool.output !== undefined && tool.isError === true).length
  const open = userOpen ?? (running || (seenLive && failedCount > 0))
  const plural = tools.length > 1 ? 's' : ''
  const label = running
    ? `${tools.length} action${plural} en cours`
    : `${tools.length} action${plural} effectuée${plural}`
  const pips = tools.slice(-MAX_PIPS)

  return (
    <div className={`tool-activity-group${open ? ' is-open' : ''}${userOpen === null ? ' is-auto' : ''}${running ? ' is-running' : ''}`}>
      <button
        type="button"
        className="tool-activity-summary"
        aria-expanded={open}
        onClick={() => setUserOpen(!open)}
      >
        <span className="tool-activity-chevron" aria-hidden="true" />
        <span className="tool-activity-pips" aria-hidden="true">
          {pips.map((tool) => (
            <i key={tool.id} className={tool.output === undefined ? 'is-running' : tool.isError ? 'is-error' : 'is-done'} />
          ))}
        </span>
        <span>{label}</span>
        {failedCount > 0 ? <span className="tool-activity-failed">{failedCount} en échec</span> : null}
        {running && tools.length > 1 ? <span className="tool-activity-count">{doneCount}/{tools.length}</span> : null}
      </button>
      <div className="tool-activity-body" inert={!open}>
        <div className="tool-activity-list">
          {tools.map((tool) => (
            <EventView key={tool.id} block={tool} onImageOpen={onImageOpen} onImageLoad={onImageLoad} />
          ))}
        </div>
      </div>
    </div>
  )
}
