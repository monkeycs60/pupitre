import { useState } from 'react'
import { ThinkingOrb, type OrbState } from 'thinking-orbs'
import type { EventBlock } from './eventBlocks'
import { EventStream } from './EventStream'
import { formatShortDuration } from './formatActiveDuration'
import { useWindowActive } from './idleLoops'
import { useNow } from './useNow'
import { useResolvedTheme } from './theme'
import { toolGroupSummary, toolPresentation, type ToolCategory } from './toolPresentation'
import { turnWorkNoteCount, turnWorkTools, type TurnWorkBlock } from './turnWork'

type ToolBlock = Extract<EventBlock, { kind: 'tool' }>
type Live = NonNullable<TurnWorkBlock['live']>

const PHASE_ACTS: Record<string, { label: string; orb: OrbState }> = {
  starting: { label: 'Démarre…', orb: 'connecting' },
  ticket_context: { label: 'Prépare le tour…', orb: 'connecting' },
  compacting: { label: 'Compacte le contexte', orb: 'breathing' },
  summarizing: { label: 'Résume', orb: 'breathing' },
  retrying: { label: 'Nouvel essai', orb: 'breathing' },
  waiting_permission: { label: 'Attend ton autorisation', orb: 'listening' },
  waiting_confirmation: { label: 'Attend ta confirmation', orb: 'listening' },
}

const CATEGORY_ORBS: Record<ToolCategory, OrbState> = {
  read: 'searching',
  search: 'searching',
  web: 'searching',
  edit: 'shaping',
  command: 'working',
  agent: 'weaving',
  other: 'working',
}

interface LiveAct {
  label: string
  detail?: string
  orb: OrbState
  waiting?: boolean
}

function liveAct(work: TurnWorkBlock, live: Live): LiveAct {
  const phase = live.phase ? PHASE_ACTS[live.phase] : undefined
  if (phase) return { ...phase, waiting: phase.orb === 'listening' }
  const running = work.blocks.findLast((block): block is ToolBlock => block.kind === 'tool' && block.output === undefined)
  if (running) {
    const presentation = toolPresentation(running)
    return { label: presentation.label, detail: presentation.detail, orb: CATEGORY_ORBS[presentation.category] }
  }
  if (live.activity === 'writing') return { label: 'Rédige', orb: 'composing' }
  const last = work.blocks.at(-1)
  if (last?.kind === 'reasoning') return { label: 'Réfléchit', detail: reasoningTitle(last.text), orb: 'solving' }
  return { label: 'Réfléchit…', orb: 'solving' }
}

function reasoningTitle(text: string): string | undefined {
  const heading = /^\s*\*\*(.+?)\*\*/.exec(text)?.[1]
  if (heading) return heading
  return /^.+?[.!?:](?=\s|$)/.exec(text.replace(/\s+/g, ' ').trim())?.[0]
}

function narration(work: TurnWorkBlock): string | null {
  const note = work.blocks.findLast((block) => block.kind === 'assistant' && block.text.trim() !== '')
  if (note?.kind !== 'assistant') return null
  return note.text.replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim()
}

function cssColor(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || undefined
}

function LiveOrb({ state, waiting }: { state: OrbState; waiting: boolean }) {
  const theme = useResolvedTheme()
  const active = useWindowActive()
  return (
    <ThinkingOrb
      className="turn-live-orb"
      state={state}
      size={20}
      theme={theme === 'light' ? 'light' : 'dark'}
      paused={!active}
      color={cssColor(waiting ? '--warn' : '--accent')}
    />
  )
}

function LiveMeta({ live, toolsDone }: { live: Live; toolsDone: number }) {
  const now = useNow(1000)
  const startedAt = Date.parse(live.timing?.startedAt ?? '')
  const parts = [
    Number.isFinite(startedAt) ? formatShortDuration(now - startedAt) : null,
    toolsDone > 0 ? `${toolsDone} action${toolsDone > 1 ? 's' : ''}` : null,
  ].filter((part) => part !== null)
  return parts.length > 0 ? <span className="turn-live-meta">{parts.join(' · ')}</span> : null
}

export function TurnWorkGroup({ work, onImageOpen, onImageLoad, onSteer }: {
  work: TurnWorkBlock
  onImageOpen: (src: string, alt: string) => void
  onImageLoad: () => void
  onSteer?: () => void
}) {
  const [open, setOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [mountedLive] = useState(work.live !== undefined)
  const tools = turnWorkTools(work)
  const notes = turnWorkNoteCount(work)
  const failedCount = tools.filter((tool) => tool.output !== undefined && tool.isError === true).length
  const expandable = work.blocks.length > 0
  const live = work.live
  const act = live ? liveAct(work, live) : null
  const note = live ? narration(work) : null

  const summary = live && act ? (
    <>
      <span className="turn-live-orb-slot" aria-hidden="true"><LiveOrb state={act.orb} waiting={act.waiting === true} /></span>
      <span className={`turn-live-act${act.waiting ? ' is-waiting' : ''}`}>
        {act.label}
        {act.detail ? <span className="turn-live-detail">{act.detail}</span> : null}
      </span>
      <LiveMeta live={live} toolsDone={tools.length - tools.filter((tool) => tool.output === undefined).length} />
    </>
  ) : (
    <>
      <svg className={`turn-done-check${mountedLive ? ' is-fresh' : ''}`} width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.5" />
        <path d="M5 8.2 7 10l4-4.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span>
        {[
          work.durationMs === undefined ? null : formatShortDuration(work.durationMs),
          tools.length > 0 ? toolGroupSummary(tools) : null,
          notes > 0 ? `${notes} ${notes > 1 ? 'messages intermédiaires' : 'message intermédiaire'}` : null,
        ].filter((part) => part !== null).join(' · ') || 'Terminé'}
      </span>
    </>
  )

  return (
    <div className={`tool-activity-group turn-work${open ? ' is-open' : ''}${live ? ' is-live' : ''}`}>
      <div className="turn-work-row">
        {expandable ? (
          <button
            type="button"
            className="tool-activity-summary turn-work-summary"
            aria-expanded={open}
            onClick={() => {
              setMounted(true)
              setOpen(!open)
            }}
          >
            {summary}
            <span className="tool-activity-chevron" aria-hidden="true" />
            {failedCount > 0 ? <span className="tool-activity-failed">{failedCount} en échec</span> : null}
          </button>
        ) : (
          <div className="tool-activity-summary turn-work-summary">{summary}</div>
        )}
        {live && onSteer ? (
          <button type="button" className="turn-live-steer" onClick={onSteer} title="Glisser une consigne sans arrêter l’agent">
            Orienter
          </button>
        ) : null}
      </div>
      {live ? <div className="turn-live-narration" role="status">{note ? `« ${note} »` : null}</div> : null}
      {expandable ? (
        <div className="tool-activity-body" inert={!open}>
          <div className="tool-activity-list turn-work-list">
            {mounted ? <EventStream blocks={work.blocks} onImageOpen={onImageOpen} onImageLoad={onImageLoad} /> : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
