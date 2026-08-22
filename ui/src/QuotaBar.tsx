import { useState } from 'react'
import { refreshQuotas } from './api'
import {
  describeWindow,
  formatCountdown,
  formatResetClock,
  msUntilReset,
  quotaFreshness,
  quotaStateSignals,
  quotaSummary,
  quotaWindowSignals,
  windowTitle,
} from './quotaSignals'
import type { Provider, QuotaSnapshot, QuotaState, QuotaWindow } from './types'
import { useNow } from './useNow'
import { HelpLink } from './HelpLink'

const PROVIDER_NAMES: Record<Provider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  grok: 'Grok',
}

/* Seuil réellement critique : la couleur d'alerte n'apparaît qu'à partir
   de 90 % d'usage, jamais avant. */
const CRITICAL_PERCENT = 90

function WindowGauge({ window, now }: { window: QuotaWindow; now: number }) {
  const remaining = msUntilReset(window, now)
  const countdown = remaining === null ? null : formatCountdown(remaining)
  const hasPercent = window.usedPercent !== null
  const isCritical = (window.usedPercent ?? 0) >= CRITICAL_PERCENT

  return (
    <div
      className={`quota-window${isCritical ? ' is-critical' : ''}`}
      title={describeWindow(window, now)}
    >
      <span className="quota-window-label">{windowTitle(window)}</span>
      {hasPercent ? (
        // Jauge remplie : codex publie un pourcentage d'usage.
        <span
          className="quota-gauge"
          role="meter"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(window.usedPercent ?? 0)}
          aria-label={`${windowTitle(window)} — ${Math.round(window.usedPercent ?? 0)}% utilisé`}
        >
          <span
            className="quota-gauge-fill"
            style={{ width: `${Math.min(100, Math.max(0, window.usedPercent ?? 0))}%` }}
          />
        </span>
      ) : null}
      <span className="quota-window-value">
        {hasPercent ? `${Math.round(window.usedPercent ?? 0)}%` : null}
        {hasPercent && countdown !== null ? ' · ' : null}
        {/* Claude ne publie pas d'usage : seul le reset est affichable.
            « imminent » se suffit à lui-même : « reset dans imminent » ne veut rien dire. */}
        {countdown !== null
          ? countdown === 'imminent' ? 'reset imminent' : `reset dans ${countdown}`
          : null}
        {!hasPercent && countdown === null ? 'inconnu' : null}
      </span>
    </div>
  )
}

function ProviderQuota({ provider, state, now }: {
  provider: Provider
  state: QuotaState | null
  now: number
}) {
  const summary = quotaSummary(provider, state, now)
  const hasWindows = state !== null && state.windows.length > 0

  return (
    <div className="quota-provider">
      <span className="quota-provider-name">
        {PROVIDER_NAMES[provider]}
        {/* Ce que le provider ne publie pas se dit, plutôt que de se deviner. */}
        {summary.note !== null ? (
          <span className="quota-caveat" title={summary.note} aria-label={summary.note}>
            ?
          </span>
        ) : null}
      </span>
      {hasWindows ? (
        state.windows.map((window) => (
          <WindowGauge key={window.label} window={window} now={now} />
        ))
      ) : (
        <span className="quota-unknown">{summary.headline}</span>
      )}
    </div>
  )
}

function CompactProviderQuota({ provider, state, now }: {
  provider: Provider
  state: QuotaState | null
  now: number
}) {
  const summary = quotaSummary(provider, state, now)
  const usedPercent = summary.usedPercent === null
    ? null
    : Math.min(100, Math.max(0, summary.usedPercent))
  const detail = [summary.headline, summary.note].filter(Boolean).join(' · ')
  const signals = quotaStateSignals(provider, state, now)
  const tooltipId = `quota-status-${provider}`
  const gaugeClassName = [
    'quota-status-gauge',
    usedPercent === null ? 'is-unknown' : '',
    signals.weeklyEnding ? 'is-weekly-ending' : '',
    signals.lastHour ? 'is-last-hour' : '',
  ].filter(Boolean).join(' ')

  function resetLabel(window: QuotaWindow): string {
    const remaining = msUntilReset(window, now)
    const clock = formatResetClock(window.resetsAt)
    if (remaining === null) return 'reset non publié'
    const countdown = remaining <= 0 ? 'imminent' : `dans ${formatCountdown(remaining)}`
    return clock === null ? countdown : `${countdown} · ${clock}`
  }

  return (
    <div
      className="quota-status-row"
      tabIndex={0}
      aria-describedby={tooltipId}
      aria-label={`${PROVIDER_NAMES[provider]} — ${detail}`}
    >
      <span className="quota-status-provider">{PROVIDER_NAMES[provider]}</span>
      {usedPercent !== null ? (
        <span
          className={`${gaugeClassName}${usedPercent >= CRITICAL_PERCENT ? ' is-critical' : ''}`}
          role="meter"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(usedPercent)}
          aria-label={`${PROVIDER_NAMES[provider]} — ${Math.round(usedPercent)} % utilisé`}
        >
          <span style={{ width: `${usedPercent}%` }} />
        </span>
      ) : (
        <span className={gaugeClassName} aria-hidden="true" />
      )}
      <span className="quota-status-value">{summary.headline}</span>

      <div className="quota-status-tooltip" id={tooltipId} role="tooltip">
        <div className="quota-status-tooltip-header">
          <strong>{PROVIDER_NAMES[provider]}</strong>
          <span>Usage et réinitialisation</span>
        </div>
        {state === null || state.windows.length === 0 ? (
          <p>{summary.headline}</p>
        ) : (
          <div className="quota-status-tooltip-list">
            {state.windows.map((window) => {
              const windowSignals = quotaWindowSignals(provider, window, now)
              const windowClassName = [
                'quota-status-tooltip-row',
                windowSignals.weeklyEnding ? 'is-weekly-ending' : '',
                windowSignals.lastHour ? 'is-last-hour' : '',
              ].filter(Boolean).join(' ')
              return (
                <div className={windowClassName} key={window.label}>
                  <span>{windowTitle(window)}</span>
                  <strong>
                    {window.usedPercent === null
                      ? 'usage non publié'
                      : `${Math.round(window.usedPercent)} % utilisé`}
                  </strong>
                  <span>{resetLabel(window)}</span>
                </div>
              )
            })}
          </div>
        )}
        {signals.lastHour || signals.weeklyEnding ? (
          <div className="quota-status-tooltip-alerts">
            {signals.lastHour ? <span className="is-last-hour">5 h · dernière heure</span> : null}
            {signals.weeklyEnding ? <span className="is-weekly-ending">Hebdo · moins de 2 jours</span> : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** Résumé permanent et compact affiché sous la liste des conversations. */
export function QuotaStatus({ snapshot }: { snapshot: QuotaSnapshot }) {
  const now = useNow()

  return (
    <section className="quota-status" aria-label="Usage des quotas">
      <CompactProviderQuota provider="claude" state={snapshot.claude} now={now} />
      <CompactProviderQuota provider="codex" state={snapshot.codex} now={now} />
    </section>
  )
}

/**
 * Détail des quotas, affiché à la demande dans le menu des outils.
 *
 * Les deux providers répondent à une lecture d'état gratuite, relevée au
 * démarrage puis périodiquement. Quand une donnée manque quand même (session
 * expirée, app-server éteint), la barre nomme la cause au lieu d'afficher
 * « inconnu » — qui se lirait comme une panne de Pupitre.
 */
export function QuotaBar({ snapshot }: { snapshot: QuotaSnapshot }) {
  const now = useNow()
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const freshness = quotaFreshness(snapshot, now)

  async function handleRefresh() {
    if (isRefreshing) return
    setIsRefreshing(true)
    setError(null)
    try {
      // Le WS `channel=quotas` diffuse le nouvel état : rien à replacer ici.
      await refreshQuotas()
    } catch (refreshError: unknown) {
      setError(
        refreshError instanceof Error ? refreshError.message : 'Relève impossible.',
      )
    } finally {
      setIsRefreshing(false)
    }
  }

  return (
    <section className="quota-bar" aria-label="Quotas">
      <ProviderQuota provider="claude" state={snapshot.claude} now={now} />
      <ProviderQuota provider="codex" state={snapshot.codex} now={now} />

      <div className="quota-bar-footer">
        {freshness !== null ? <span className="quota-freshness">{freshness}</span> : null}
        <button
          type="button"
          className="quota-refresh"
          onClick={() => void handleRefresh()}
          disabled={isRefreshing}
          title="Relever les quotas des deux providers maintenant. Deux lectures gratuites : aucun quota consommé."
        >
          {isRefreshing ? 'Relève…' : 'Actualiser'}
        </button>
      </div>
      {error !== null ? (
        <p className="quota-error" role="alert">{error}</p>
      ) : null}
      <HelpLink slug="quotas" label="Comprendre les quotas" />
    </section>
  )
}
