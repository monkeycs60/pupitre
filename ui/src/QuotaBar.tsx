import {
  describeWindow,
  formatCountdown,
  msUntilReset,
  quotaFreshness,
  windowTitle,
} from './quotaSignals'
import type { Provider, QuotaSnapshot, QuotaState, QuotaWindow } from './types'
import { useNow } from './useNow'

const PROVIDER_NAMES: Record<Provider, string> = {
  claude: 'Claude',
  codex: 'Codex',
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
  return (
    <div className="quota-provider">
      <span className="quota-provider-name">{PROVIDER_NAMES[provider]}</span>
      {state === null || state.windows.length === 0 ? (
        <span className="quota-unknown">inconnu</span>
      ) : (
        state.windows.map((window) => (
          <WindowGauge key={window.label} window={window} now={now} />
        ))
      )}
    </div>
  )
}

/**
 * Barre de statut permanente en bas de la sidebar. Tant qu'aucun tour n'a été
 * joué, les deux providers affichent « inconnu » (les quotas ne sont connus
 * qu'après un premier événement rate-limit).
 */
export function QuotaBar({ snapshot, isUnknown }: {
  snapshot: QuotaSnapshot
  isUnknown: boolean
}) {
  const now = useNow()
  const freshness = quotaFreshness(snapshot, now)

  return (
    <section className="quota-bar" aria-label="Quotas">
      {isUnknown ? (
        <p className="quota-empty">
          Quotas inconnus — lancez un tour pour les découvrir.
        </p>
      ) : (
        <>
          <ProviderQuota provider="claude" state={snapshot.claude} now={now} />
          <ProviderQuota provider="codex" state={snapshot.codex} now={now} />
        </>
      )}
      {freshness !== null ? <span className="quota-freshness">{freshness}</span> : null}
    </section>
  )
}
