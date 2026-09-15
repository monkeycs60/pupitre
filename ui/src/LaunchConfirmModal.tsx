import { createPortal } from 'react-dom'
import { modelLabel, PROVIDER_LABELS } from './modelOptions'
import type { Provider } from './types'

interface LaunchConfirmModalProps {
  provider: Provider
  model: string
  isTodo: boolean
  onCancel: () => void
  onConfirm: () => void
}

export function LaunchConfirmModal({ provider, model, isTodo, onCancel, onConfirm }: LaunchConfirmModalProps) {
  const target = `${PROVIDER_LABELS[provider]} · ${modelLabel(model)}`
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
