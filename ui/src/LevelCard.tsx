import { useState } from 'react'
import { formatActiveDuration } from './formatActiveDuration'
import type { TimeCounter, TimeMode, TimeSnapshot } from './types'

const RING_LENGTH = 110
const MINUTE_MS = 60_000

/**
 * La barre avance d'un cran par minute : la donnée reste à la seconde, seul
 * l'affichage est quantifié. Un cran vaut 3,6 px sur 219 — visible sans
 * prétendre à une précision que l'œil ne saurait lire.
 */
function steppedProgress(counter: TimeCounter): number {
  return Math.floor(counter.levelMs / MINUTE_MS) * MINUTE_MS / 3_600_000
}

function SwapIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        <path d="M1.5 4h9M8 1.5 10.5 4 8 6.5" />
        <path d="M10.5 8h-9M4 5.5 1.5 8 4 10.5" />
      </g>
    </svg>
  )
}

export function LevelCard({
  snapshot,
  mode,
  agentRunning,
  onToggle,
}: {
  snapshot: TimeSnapshot
  mode: TimeMode
  agentRunning: boolean
  onToggle: () => void
}) {
  const [hovered, setHovered] = useState(false)
  const isAgent = mode === 'agent'
  const counter = isAgent ? snapshot.agent : snapshot.user
  const other = isAgent ? snapshot.user : snapshot.agent
  const otherLabel = isAgent ? 'Utilisateur' : 'Agent'
  const progress = steppedProgress(counter)
  const remaining = Math.ceil((3_600_000 - counter.levelMs) / MINUTE_MS)
  // En mode utilisateur, la part de TES heures passées à regarder tourner ;
  // en mode agent, la part des heures d'agent que tu as effectivement suivies.
  const share = counter.ms > 0 ? Math.round((snapshot.supervisionMs / counter.ms) * 100) : 0

  return (
    <button
      type="button"
      className="level-card"
      data-mode={mode}
      onClick={onToggle}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
      title={`${remaining} min avant le niveau ${counter.level + 1} · cliquer pour afficher le compteur ${otherLabel.toLowerCase()}`}
    >
      <span className="level-ring" aria-hidden="true">
        <svg width="42" height="42" viewBox="0 0 42 42">
          <circle cx="21" cy="21" r="17.5" fill="none" stroke="var(--border)" strokeWidth="4" />
          <circle
            cx="21"
            cy="21"
            r="17.5"
            fill="none"
            className="level-ring-fill"
            strokeWidth="4"
            strokeLinecap="round"
            strokeDasharray={RING_LENGTH}
            strokeDashoffset={RING_LENGTH * (1 - progress)}
            transform="rotate(-90 21 21)"
          />
        </svg>
        <span className="level-ring-value">{counter.level}</span>
      </span>
      <span className="level-info">
        <span className="level-info-top">
          <strong>{isAgent ? 'Agent' : 'Utilisateur'}</strong>
          {hovered ? (
            <span className="level-share">
              {share} % {isAgent ? 'suivi' : 'supervisé'}
            </span>
          ) : snapshot.scope === 'global' ? (
            <span className="level-scope">
              {snapshot.projectCount} projet{snapshot.projectCount > 1 ? 's' : ''}
            </span>
          ) : null}
        </span>
        <span className="level-bar" aria-hidden="true">
          <span className="level-bar-fill" style={{ width: `${progress * 100}%` }} />
        </span>
        <span className="level-meta">
          <span className="level-today">
            {formatActiveDuration(counter.todayMs)} aujourd’hui
          </span>
          {hovered ? (
            <span className="level-swap">
              <SwapIcon />
              {otherLabel} {formatActiveDuration(other.ms)}
            </span>
          ) : agentRunning ? (
            <span className="level-running">
              <i aria-hidden="true" />
              agent
            </span>
          ) : null}
        </span>
      </span>
    </button>
  )
}
