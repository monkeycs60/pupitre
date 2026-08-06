import { quotaSummary } from './quotaSignals'
import type { Provider, QuotaState } from './types'
import { useNow } from './useNow'

/* Au-delà, la couleur passe à l'alerte. Aligné sur QuotaBar. */
const CRITICAL_PERCENT = 90

/**
 * État du quota d'un provider, en une ligne. Le quota est publié par fenêtre et
 * par provider — jamais par modèle : cette jauge appartient donc au choix du
 * provider, pas aux cartes de modèles.
 */
export function QuotaMeter({ provider, state }: {
  provider: Provider
  state: QuotaState | null
}) {
  const now = useNow()
  const summary = quotaSummary(provider, state, now)
  const hasPercent = summary.usedPercent !== null
  const isCritical = (summary.usedPercent ?? 0) >= CRITICAL_PERCENT

  return (
    <div
      className={`quota-meter${hasPercent ? '' : ' is-flat'}${isCritical ? ' is-critical' : ''}`}
      title={summary.note ?? undefined}
    >
      {hasPercent ? (
        <span
          className="quota-meter-gauge"
          role="meter"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(summary.usedPercent ?? 0)}
          aria-label={`Quota ${provider} — ${Math.round(summary.usedPercent ?? 0)} % utilisé`}
        >
          <span
            className="quota-meter-fill"
            style={{ width: `${Math.min(100, Math.max(0, summary.usedPercent ?? 0))}%` }}
          />
        </span>
      ) : null}
      <span className="quota-meter-text">{summary.headline}</span>
      {summary.note !== null && !hasPercent ? (
        <span className="quota-meter-note">?</span>
      ) : null}
    </div>
  )
}
