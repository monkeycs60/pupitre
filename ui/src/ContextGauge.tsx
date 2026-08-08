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

/** Créneaux de la palette validée : au-delà, on retombe sur une nuance. */
const PALETTE_SLOTS = 8

export function ContextGauge({
  conversation,
  events,
  conductorTokens = 0,
  contextBaseline = 0,
  contextProfile,
  mcpServers = [],
  mcpWeights = {},
  onOpenProjectSettings,
  onHandoff,
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
  onHandoff: () => void
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
  // Une teinte distincte par part, dans l'ordre de la palette. Au-delà de ses
  // huit créneaux on réutilise le premier avec une nuance, plutôt que
  // d'inventer une teinte non validée.
  let slot = 0
  const slices: DonutSlice[] = parts.map((part) => {
    const index = part.free ? -1 : slot++
    return {
      label: part.label,
      value: part.tokens,
      groupLabel: GROUP_LABELS[part.group],
      colorIndex: (index % PALETTE_SLOTS) + 1,
      shade: Math.floor(index / PALETTE_SLOTS),
      detail: part.detail,
      hatched: part.persistent,
      muted: part.free,
      inferred: part.inferred,
    }
  })
  const persistent = persistentRatio(parts, estimate.windowTokens)
  const persistentAlert = persistent >= PERSISTENT_ALERT_RATIO

  // Anneau circulaire (r = 10.5 → circonférence ≈ 66) coloré selon l'état.
  const RING_LEN = 66
  const ringOffset = RING_LEN * (1 - Math.max(0, Math.min(100, estimate.percent)) / 100)
  const status = estimate.nearSaturation
    ? 'Handoff conseillé'
    : persistentAlert
      ? 'Charge fixe élevée'
      : 'Sous contrôle'

  return (
    <div
      className={[
        'context-gauge',
        estimate.nearSaturation ? 'is-near-limit' : '',
        // Signal passif : la jauge se colore sans exiger le survol.
        persistentAlert ? 'is-heavy-fixed' : '',
      ].join(' ').trim()}
    >
      <div
        className="context-gauge-hover"
        role="progressbar"
        aria-label="Contexte estimé"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={estimate.percent}
        aria-describedby="context-gauge-detail"
      >
        <span className="context-gauge-ring" aria-hidden="true">
          <svg width="26" height="26" viewBox="0 0 26 26">
            <circle cx="13" cy="13" r="10.5" fill="none" stroke="var(--border)" strokeWidth="3" />
            <circle
              cx="13"
              cy="13"
              r="10.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray={RING_LEN}
              strokeDashoffset={ringOffset}
              transform="rotate(-90 13 13)"
            />
          </svg>
        </span>
        <span className="context-gauge-text">
          <span className="context-gauge-value">Contexte {estimate.percent}%</span>
          <span className="context-gauge-status">{status}</span>
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

      <button
        type="button"
        className="context-gauge-handoff"
        onClick={onHandoff}
        title={estimate.nearSaturation
          ? 'Préparer un handoff avant la saturation du contexte'
          : 'Préparer un handoff de la session'}
      >
        Passer la main
      </button>
    </div>
  )
}
