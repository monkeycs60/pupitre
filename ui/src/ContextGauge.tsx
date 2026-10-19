import { memo, useMemo, useState } from 'react'
import { getDiscussionDocument } from './api'
import { copyText } from './clipboard'
import { contextEstimate, formatContextWindow } from './contextEstimate'
import type { AppEvent, Conversation } from './types'

// memo + useMemo : l'estimation parcourt tous les événements du fil, elle ne
// doit tourner qu'à leur changement, pas à chaque re-render du parent.
export const ContextGauge = memo(function ContextGauge({
  conversation,
  events,
  onContinueElsewhere,
}: {
  conversation: Conversation
  events: AppEvent[]
  onContinueElsewhere: () => void
}) {
  const estimate = useMemo(
    () => contextEstimate(events, conversation.provider, conversation.model),
    [events, conversation.provider, conversation.model],
  )
  const [copied, setCopied] = useState(false)
  const [copying, setCopying] = useState(false)
  const [copyError, setCopyError] = useState<string | null>(null)
  const formattedWindow = formatContextWindow(estimate.windowTokens)
  const percent = Math.max(0, Math.min(100, estimate.percent))

  async function copyDiscussion() {
    if (copying) return
    setCopying(true)
    setCopyError(null)
    try {
      await copyText((await getDiscussionDocument(conversation.id)).contentMd)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1_500)
    } catch (error: unknown) {
      setCopyError(error instanceof Error ? error.message : 'Copie impossible.')
    } finally {
      setCopying(false)
    }
  }

  return (
    <div className={`context-gauge${estimate.nearSaturation ? ' is-near-limit' : ''}`}>
      <div className="context-gauge-menu" role="group" aria-label="Passer la main">
        <div className="context-gauge-menu-card">
          <button type="button" onClick={() => void copyDiscussion()} disabled={copying}>
            <span className="context-gauge-menu-label">
              {copied ? 'Discussion copiée' : copying ? 'Copie…' : 'Copier la discussion'}
            </span>
            <span className="context-gauge-menu-detail">Tout le fil en Markdown</span>
          </button>
          <button type="button" onClick={onContinueElsewhere}>
            <span className="context-gauge-menu-label">Continuer la conversation ailleurs</span>
            <span className="context-gauge-menu-detail">Id et consigne dans une nouvelle conversation</span>
          </button>
          {copyError !== null ? <p className="context-gauge-menu-error" role="alert">{copyError}</p> : null}
        </div>
      </div>
      <div
        className="context-gauge-summary"
        role="progressbar"
        aria-label={`Contexte ${estimate.percent} %, fenêtre ${formattedWindow}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={estimate.percent}
        tabIndex={0}
      >
        <svg className="context-gauge-dial" width="26" height="15" viewBox="0 0 26 15" aria-hidden="true">
          <path d="M2.5 13.5a10.5 10.5 0 0 1 21 0" fill="none" stroke="var(--border)" strokeWidth="2.6" strokeLinecap="round" />
          <path
            d="M2.5 13.5a10.5 10.5 0 0 1 21 0"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.6"
            strokeLinecap="round"
            pathLength={100}
            strokeDasharray="100"
            strokeDashoffset={100 - percent}
          />
          <line
            x1="13"
            y1="13.5"
            x2="13"
            y2="6"
            stroke="var(--text-strong)"
            strokeWidth="1.5"
            strokeLinecap="round"
            transform={`rotate(${(percent - 50) * 1.8} 13 13.5)`}
          />
        </svg>
        <span>{estimate.percent} %</span>
        <span className="context-gauge-capacity" aria-hidden="true">· {formattedWindow}</span>
      </div>
    </div>
  )
})
