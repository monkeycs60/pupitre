import { contextEstimate, formatContextWindow } from './contextEstimate'
import type { AppEvent, Conversation } from './types'

export function ContextGauge({
  conversation,
  events,
  onHandoff,
}: {
  conversation: Conversation
  events: AppEvent[]
  onHandoff: () => void
}) {
  const estimate = contextEstimate(events, conversation.provider, conversation.model)
  const formattedWindow = formatContextWindow(estimate.windowTokens)
  const ringLength = 66
  const ringOffset = ringLength * (1 - Math.max(0, Math.min(100, estimate.percent)) / 100)

  return (
    <div className={`context-gauge${estimate.nearSaturation ? ' is-near-limit' : ''}`}>
      <div
        className="context-gauge-summary"
        role="progressbar"
        aria-label={`Contexte ${estimate.percent} %, fenêtre ${formattedWindow}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={estimate.percent}
        tabIndex={0}
      >
        <span className="context-gauge-ring" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 26 26">
            <circle cx="13" cy="13" r="10.5" fill="none" stroke="var(--border)" strokeWidth="3" />
            <circle
              cx="13"
              cy="13"
              r="10.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray={ringLength}
              strokeDashoffset={ringOffset}
              transform="rotate(-90 13 13)"
            />
          </svg>
        </span>
        <span>{estimate.percent} %</span>
        <span className="context-gauge-capacity" aria-hidden="true">· {formattedWindow}</span>
      </div>
      <button type="button" className="context-gauge-handoff" onClick={onHandoff}>
        Passer la main
      </button>
    </div>
  )
}
