import { contextEstimate } from './contextEstimate'
import type { AppEvent, Conversation } from './types'

export function ContextGauge({
  conversation,
  events,
  onHandoffSuggested,
}: {
  conversation: Conversation
  events: AppEvent[]
  onHandoffSuggested: () => void
}) {
  const estimate = contextEstimate(
    events,
    conversation.provider,
    conversation.model,
  )
  const title = [
    `${estimate.usedTokens.toLocaleString('fr-FR')} tokens connus`,
    `sur une fenêtre estimée à ${estimate.windowTokens.toLocaleString('fr-FR')}`,
    'Cette jauge est indicative et ne déclenche aucun compactage automatique.',
  ].join(' · ')

  return (
    <div className={`context-gauge ${estimate.nearSaturation ? 'is-near-limit' : ''}`}>
      <div
        className="context-gauge-track"
        role="progressbar"
        aria-label="Contexte estimé"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={estimate.percent}
        title={title}
      >
        <span style={{ width: `${estimate.percent}%` }} />
      </div>
      <span title={title}>Contexte ≈ {estimate.percent}%</span>
      {estimate.nearSaturation ? (
        <button type="button" onClick={onHandoffSuggested}>
          Handoff-débrief conseillé
        </button>
      ) : null}
    </div>
  )
}
