import { useState } from 'react'
import type { EventBlock } from './eventBlocks'
import { EventView } from './EventView'
import { toolGroupSummary } from './toolPresentation'

type ToolBlock = Extract<EventBlock, { kind: 'tool' }>

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
  const failedCount = tools.filter((tool) => tool.output !== undefined && tool.isError === true).length
  const open = userOpen ?? (running || (seenLive && failedCount > 0))

  if (tools.length === 1) {
    return (
      <div className="tool-activity-solo">
        <EventView block={tools[0]} onImageOpen={onImageOpen} onImageLoad={onImageLoad} />
      </div>
    )
  }

  return (
    <div className={`tool-activity-group${open ? ' is-open' : ''}${userOpen === null ? ' is-auto' : ''}${running ? ' is-running' : ''}`}>
      <button
        type="button"
        className="tool-activity-summary"
        aria-expanded={open}
        onClick={() => setUserOpen(!open)}
      >
        <span className="tool-activity-chevron" aria-hidden="true" />
        <span>{toolGroupSummary(tools)}</span>
        {failedCount > 0 ? <span className="tool-activity-failed">{failedCount} en échec</span> : null}
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
