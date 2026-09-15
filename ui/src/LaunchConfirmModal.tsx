import { createPortal } from 'react-dom'
import { modelLabel, PROVIDER_LABELS } from './modelOptions'
import {
  formatCountdown,
  launchQuotaWindows,
  msUntilReset,
  quotaStateFreshness,
  windowTitle,
} from './quotaSignals'
import type { Provider, QuotaState } from './types'
import { useNow } from './useNow'

interface LaunchConfirmModalProps {
  provider: Provider
  model: string
  quota: QuotaState | null
  isTodo: boolean
  onCancel: () => void
  onConfirm: () => void
}

const CRITICAL_PERCENT = 90

export function LaunchConfirmModal({ provider, model, quota, isTodo, onCancel, onConfirm }: LaunchConfirmModalProps) {
  const now = useNow()
  const target = `${PROVIDER_LABELS[provider]} · ${modelLabel(model)}`
  const windows = launchQuotaWindows(quota, model)
  const freshness = quotaStateFreshness(quota, now)
  return createPortal(
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={onCancel}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel()
      }}
    >
      <section
        className="switch-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="launch-confirm-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <h2 id="launch-confirm-title">Utiliser {target} ?</h2>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="Fermer">×</button>
        </header>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            onConfirm()
          }}
        >
          <p className="switch-warning">
            Êtes-vous sûr de {isTodo ? 'préparer cette tâche' : 'lancer cette conversation'} avec{' '}
            <strong>{target}</strong> ? Ce modèle consomme fortement le quota.
          </p>
          <div className="launch-quota" aria-label={`Quota ${PROVIDER_LABELS[provider]}`}>
            {windows.length === 0 ? (
              <p className="launch-quota-empty">Quota {PROVIDER_LABELS[provider]} jamais relevé.</p>
            ) : windows.map((window) => {
              const remaining = msUntilReset(window, now)
              const percent = window.usedPercent === null ? null : Math.round(window.usedPercent)
              return (
                <div className={`launch-quota-row${(percent ?? 0) >= CRITICAL_PERCENT ? ' is-critical' : ''}`} key={window.label}>
                  <span className="launch-quota-title">{windowTitle(window)}</span>
                  <span
                    className="launch-quota-gauge"
                    role="meter"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={percent ?? undefined}
                    aria-label={`${windowTitle(window)} : ${percent === null ? 'usage non publié' : `${percent} % utilisé`}`}
                  >
                    <span className="launch-quota-fill" style={{ width: `${Math.min(100, Math.max(0, percent ?? 0))}%` }} />
                  </span>
                  <span className="launch-quota-value">{percent === null ? '—' : `${percent} %`}</span>
                  <span className="launch-quota-reset">
                    {remaining === null ? '' : `reset dans ${formatCountdown(remaining)}`}
                  </span>
                </div>
              )
            })}
            {quota !== null ? (
              <p className={`launch-quota-freshness${freshness.stale ? ' is-stale' : ''}`}>
                Relevé {freshness.label}
              </p>
            ) : null}
          </div>
          <footer>
            <button type="button" className="secondary-button" onClick={onCancel}>
              Annuler
            </button>
            <button type="submit" className="primary-button" autoFocus>
              Confirmer
            </button>
          </footer>
        </form>
      </section>
    </div>,
    document.body,
  )
}
