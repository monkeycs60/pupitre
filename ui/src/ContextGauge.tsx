import {
  PERSISTENT_ALERT_RATIO,
  contextEstimate,
  contextParts,
  persistentRatio,
} from './contextEstimate'
import { DonutChart } from './DonutChart'
import type { DonutSlice } from './DonutChart'
import { formatCompact } from './formatCompact'
import type { McpServerRef } from './api'
import type { AppEvent, Conversation } from './types'

export function ContextGauge({
  conversation,
  events,
  conductorTokens = 0,
  mcpServers = [],
  onHandoffSuggested,
}: {
  conversation: Conversation
  events: AppEvent[]
  /** Coût mesuré du bridge conductor, exposé par le sidecar. */
  conductorTokens?: number
  /** Serveurs MCP de l'utilisateur : nommés dans l'alerte de charge fixe. */
  mcpServers?: McpServerRef[]
  onHandoffSuggested: () => void
}) {
  const estimate = contextEstimate(
    events,
    conversation.provider,
    conversation.model,
  )
  const parts = contextParts(
    events,
    estimate.usedTokens,
    estimate.windowTokens,
    conversation.orchestrator ? conductorTokens : 0,
  )
  const slices: DonutSlice[] = parts.map((part) => ({
    label: part.label,
    value: part.tokens,
    hatched: part.persistent,
    muted: part.free,
    inferred: part.inferred,
  }))
  const persistent = persistentRatio(parts, estimate.windowTokens)
  const persistentAlert = persistent >= PERSISTENT_ALERT_RATIO

  return (
    <div className={`context-gauge ${estimate.nearSaturation ? 'is-near-limit' : ''}`}>
      <div className="context-gauge-hover">
        <div
          className="context-gauge-track"
          role="progressbar"
          aria-label="Contexte estimé"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={estimate.percent}
          aria-describedby="context-gauge-detail"
        >
          <span style={{ width: `${estimate.percent}%` }} />
        </div>
        <span className="context-gauge-value">Contexte ≈ {estimate.percent}%</span>

        <div className="context-gauge-detail" id="context-gauge-detail" role="tooltip">
          <div className="context-gauge-detail-header">
            <strong>{formatCompact(estimate.usedTokens)} tokens occupés</strong>
            <span>fenêtre {formatCompact(estimate.windowTokens)}</span>
          </div>
          {slices.length === 0 ? (
            <p>Aucun tour terminé : le provider n’a pas encore publié d’usage.</p>
          ) : (
            <DonutChart
              slices={slices}
              total={estimate.windowTokens}
              centerValue={estimate.usedTokens}
              caption="Répartition de la fenêtre de contexte"
            />
          )}
          {persistentAlert ? (
            <p className="context-gauge-alert" role="status">
              <strong>{Math.round(persistent * 100)} % de la fenêtre part en charge fixe.</strong>{' '}
              Cette charge est payée dans <em>toutes</em> vos conversations.
              {mcpServers.length > 0 ? (
                <>
                  {' '}Vos {mcpServers.length} serveurs MCP y contribuent :{' '}
                  <span className="context-gauge-servers">
                    {mcpServers.map((server) => server.name).join(', ')}
                  </span>
                  . En désactiver un que vous n’utilisez pas libère du contexte partout.
                </>
              ) : (
                ' Réduire les serveurs MCP chargés libère du contexte partout.'
              )}
            </p>
          ) : null}
          <p>
            Le total vient du provider ; la répartition est estimée depuis les
            événements. Les parts hachées <span aria-hidden="true">▨</span> sont
            rechargées à chaque session : ni un résumé ni une nouvelle
            conversation ne les réduisent.
          </p>
        </div>
      </div>

      {estimate.nearSaturation ? (
        <button type="button" onClick={onHandoffSuggested}>
          Handoff-débrief conseillé
        </button>
      ) : null}
    </div>
  )
}
