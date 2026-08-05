import { useState } from 'react'
import type { FormEvent } from 'react'
import { startFlagCounterOpinion, startReviewCounterOpinions } from './api'
import { PROVIDER_EFFORTS, REVIEW_MODELS } from './modelOptions'
import type { Provider, Review, ReviewFlag } from './types'

interface CounterOpinionDialogProps {
  review: Review
  flag: ReviewFlag | null
  onClose: () => void
  onStarted: () => void
}

function opposite(provider: Provider): Provider {
  return provider === 'claude' ? 'codex' : 'claude'
}

function defaultModel(provider: Provider): string {
  return provider === 'claude' ? 'opus' : 'gpt-5.6-sol'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Impossible de lancer le contre-avis.'
}

export function CounterOpinionDialog({
  review,
  flag,
  onClose,
  onStarted,
}: CounterOpinionDialogProps) {
  const storedProviders = new Set(review.flags.map((item) => item.code_provider))
  const mixedProviders = !flag && storedProviders.size > 1
  const [codeProvider, setCodeProvider] = useState(flag?.code_provider ?? review.code_provider)
  const provider = mixedProviders ? null : opposite(codeProvider)
  const [model, setModel] = useState(defaultModel(provider ?? 'codex'))
  const [effort, setEffort] = useState('high')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (isSubmitting) return
    setIsSubmitting(true)
    setError(null)
    try {
      if (flag) await startFlagCounterOpinion(flag.id, model, effort, codeProvider)
      else if (mixedProviders) await startReviewCounterOpinions(review.id)
      else await startReviewCounterOpinions(review.id, model, effort)
      onStarted()
    } catch (submitError: unknown) {
      setError(errorMessage(submitError))
      setIsSubmitting(false)
    }
  }

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={onClose}
      onKeyDown={(event) => { if (event.key === 'Escape') onClose() }}
    >
      <section
        className="modal counter-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="counter-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div>
            <h2 id="counter-dialog-title">
              {flag ? 'Contre-avis ciblé' : 'Contre-avis sur tous les points'}
            </h2>
            <p>
              {mixedProviders
                ? 'Les auteurs sont mémorisés point par point : chaque jugement passe au provider opposé.'
                : `Le code vient de ${codeProvider} : le jugement passe à ${provider}.`}
            </p>
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Fermer">×</button>
        </header>

        <form className="counter-dialog-form" onSubmit={(event) => void handleSubmit(event)}>
          {flag ? (
            <div className={`counter-dialog-flag severity-${flag.severity}`}>
              <span>{flag.file}:{flag.line_start}</span>
              <p>{flag.message}</p>
            </div>
          ) : (
            <p className="counter-dialog-scope">
              {review.flags.length} point{review.flags.length === 1 ? '' : 's'} seront
              traités par sous-tâches parallèles, sans modifier le projet.
            </p>
          )}

          <div className="counter-dialog-grid">
            {flag ? (
              <label>
                <span>Auteur de ce point</span>
                <select
                  autoFocus
                  value={codeProvider}
                  onChange={(event) => {
                    const author = event.target.value as Provider
                    const nextProvider = opposite(author)
                    setCodeProvider(author)
                    setModel(defaultModel(nextProvider))
                    setEffort('high')
                  }}
                >
                  <option value="codex">codex</option>
                  <option value="claude">claude</option>
                </select>
              </label>
            ) : null}
            <label>
              <span>{mixedProviders ? 'Providers opposés' : 'Provider opposé'}</span>
              <input
                className="field-mono"
                autoFocus={!flag}
                value={mixedProviders ? 'codex + claude' : provider ?? ''}
                readOnly
              />
            </label>
            {provider ? (
              <>
                <label>
                  <span>Modèle fort</span>
                  <select
                    className="field-mono"
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                  >
                    {REVIEW_MODELS[provider].map((name) => (
                      <option key={name} value={name}>{name}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Effort</span>
                  <select value={effort} onChange={(event) => setEffort(event.target.value)}>
                    {PROVIDER_EFFORTS[provider].map((name) => (
                      <option key={name} value={name}>{name}</option>
                    ))}
                  </select>
                </label>
              </>
            ) : null}
          </div>

          <p className="counter-dialog-note">
            Objectif : augmenter la certitude. Le second modèle peut confirmer,
            infirmer ou nuancer — il n’est pas chargé de contredire le premier.
          </p>
          {error ? <p className="modal-error" role="alert">{error}</p> : null}

          <footer className="modal-actions">
            <button type="button" className="secondary-button" onClick={onClose}>Annuler</button>
            <button type="submit" className="primary-button" disabled={isSubmitting}>
              {isSubmitting ? 'Lancement…' : 'Demander le contre-avis'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  )
}
