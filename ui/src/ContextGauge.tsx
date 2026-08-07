import {
  PERSISTENT_ALERT_RATIO,
  contextEstimate,
  contextParts,
  persistentRatio,
} from './contextEstimate'
import { DonutChart } from './DonutChart'
import type { ContextGroup } from './contextEstimate'
import type { DonutSlice } from './DonutChart'
import { formatCompact } from './formatCompact'
import type { ContextProfile, McpServerRef } from './api'
import type { AppEvent, Conversation } from './types'

/** Titres de section de la légende, dans l'ordre de lecture de l'anneau. */
const GROUP_LABELS: Record<ContextGroup, string> = {
  fixe: 'Rechargé à chaque session',
  conversation: 'Conversation en cours',
  outils: 'Travail des outils',
  libre: 'Reste',
}

/** Une teinte par groupe : l'anneau se lit par blocs, pas part par part. */
const GROUP_COLORS: Record<ContextGroup, number> = {
  fixe: 1,
  conversation: 2,
  outils: 3,
  libre: 4,
}

export function ContextGauge({
  conversation,
  events,
  conductorTokens = 0,
  contextBaseline = 0,
  contextProfile,
  mcpServers = [],
  mcpWeights = {},
  onOpenProjectSettings,
  onHandoffSuggested,
}: {
  conversation: Conversation
  events: AppEvent[]
  /** Coût mesuré du bridge conductor, exposé par le sidecar. */
  conductorTokens?: number
  /** Contexte d'un tour à vide, mesuré : borne la charge fixe affichée. */
  contextBaseline?: number
  /** Poids mesurés des instructions et des serveurs MCP. */
  contextProfile?: ContextProfile
  /** Dernier poids mesuré par serveur, affiché en regard de chaque nom. */
  mcpWeights?: Record<string, { tokens: number | null }>
  /** Ouvre la configuration du projet, pour agir depuis le diagnostic. */
  onOpenProjectSettings?: () => void
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
    contextBaseline,
    contextProfile,
  )
  // Rang dans le groupe : c'est lui qui choisit la nuance de la teinte.
  const rank = new Map<ContextGroup, number>()
  const slices: DonutSlice[] = parts.map((part) => ({
    label: part.label,
    value: part.tokens,
    groupLabel: GROUP_LABELS[part.group],
    colorIndex: GROUP_COLORS[part.group],
    shade: (() => {
      const next = rank.get(part.group) ?? 0
      rank.set(part.group, next + 1)
      return next
    })(),
    detail: part.detail,
    hatched: part.persistent,
    muted: part.free,
    inferred: part.inferred,
  }))
  const persistent = persistentRatio(parts, estimate.windowTokens)
  const persistentAlert = persistent >= PERSISTENT_ALERT_RATIO

  return (
    <div
      className={[
        'context-gauge',
        estimate.nearSaturation ? 'is-near-limit' : '',
        // Signal passif : la jauge se colore sans exiger le survol.
        persistentAlert ? 'is-heavy-fixed' : '',
      ].join(' ').trim()}
    >
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
        <span className="context-gauge-value">
          Contexte ≈ {estimate.percent}%
          {persistentAlert ? (
            <span className="context-gauge-badge" title="Charge fixe élevée : voir le détail">
              ▨ {Math.round(persistent * 100)} %
            </span>
          ) : null}
        </span>

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
              Cette charge est payée dans <em>toutes</em> vos conversations : désactiver
              un serveur MCP inutilisé libère du contexte partout.
            </p>
          ) : null}
          {mcpServers.length > 0 ? (
            <details className="context-gauge-servers-list">
              <summary>
                {mcpServers.length} serveurs MCP chargés
                {onOpenProjectSettings ? (
                  <button
                    type="button"
                    className="text-button"
                    onClick={onOpenProjectSettings}
                  >
                    Configurer
                  </button>
                ) : null}
              </summary>
              <ul>
                {mcpServers.map((server) => {
                  const tokens = mcpWeights[server.name]?.tokens
                  return (
                    <li key={`${server.provider}:${server.name}`}>
                      <span className={`project-mcp-badge is-${server.provider}`}>
                        {server.provider === 'claude' ? 'CL' : 'CX'}
                      </span>
                      <span className="context-gauge-server-name">{server.name}</span>
                      <span className="context-gauge-server-cost">
                        {typeof tokens === 'number' ? formatCompact(tokens) : '—'}
                      </span>
                    </li>
                  )
                })}
              </ul>
            </details>
          ) : null}
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
