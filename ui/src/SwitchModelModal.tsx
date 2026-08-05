import { useState } from 'react'
import type { FormEvent } from 'react'
import {
  handoffConversation,
  switchConversationModel,
} from './api'
import { PROVIDER_EFFORTS, PROVIDER_MODELS } from './modelOptions'
import { estimatedReingestionTokens } from './modelSwitch'
import type {
  AppEvent,
  Conversation,
  ConversationSpeed,
  Provider,
} from './types'

interface SwitchModelModalProps {
  conversation: Conversation
  events: AppEvent[]
  onClose: () => void
  onSwitched: (conversation: Conversation) => void
  onHandoff: (conversation: Conversation) => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Une erreur est survenue.'
}

export function SwitchModelModal({
  conversation,
  events,
  onClose,
  onSwitched,
  onHandoff,
}: SwitchModelModalProps) {
  const [provider, setProvider] = useState<Provider>(conversation.provider)
  const [model, setModel] = useState(conversation.model)
  const [effort, setEffort] = useState(conversation.effort ?? 'high')
  const [speed, setSpeed] = useState<ConversationSpeed>(
    conversation.speed ?? 'standard',
  )
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isHandoff = provider !== conversation.provider
  const tokenEstimate = estimatedReingestionTokens(events)

  function handleProviderChange(nextProvider: Provider) {
    setProvider(nextProvider)
    setModel(PROVIDER_MODELS[nextProvider][0])
    setEffort('high')
    setSpeed('standard')
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setIsSubmitting(true)
    setError(null)
    const config = {
      provider,
      model,
      effort,
      speed: provider === 'codex' ? speed : null,
      orchestrator: conversation.orchestrator,
    }
    try {
      if (isHandoff) {
        onHandoff(await handoffConversation(conversation.id, config))
      } else {
        const result = await switchConversationModel(conversation.id, config)
        onSwitched(result.conversation)
      }
    } catch (submitError: unknown) {
      setError(errorMessage(submitError))
      setIsSubmitting(false)
    }
  }

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={() => { if (!isSubmitting) onClose() }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !isSubmitting) onClose()
      }}
    >
      <section
        className="switch-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="switch-model-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <h2 id="switch-model-title">Changer de modèle</h2>
          </div>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            aria-label="Fermer"
            disabled={isSubmitting}
          >
            ×
          </button>
        </header>

        <form onSubmit={(event) => void handleSubmit(event)}>
          <div className="switch-fields">
            <label>
              <span>Provider</span>
              <select
                autoFocus
                value={provider}
                onChange={(event) => handleProviderChange(event.target.value as Provider)}
              >
                <option value="claude">claude</option>
                <option value="codex">codex</option>
              </select>
            </label>
            <label>
              <span>Modèle</span>
              <select
                className="field-mono"
                value={model}
                onChange={(event) => setModel(event.target.value)}
              >
                {PROVIDER_MODELS[provider].map((name) => (
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
            {provider === 'codex' ? (
              <label>
                <span>Vitesse</span>
                <select
                  value={speed}
                  onChange={(event) => setSpeed(event.target.value as ConversationSpeed)}
                >
                  <option value="standard">Standard</option>
                  <option value="fast">Rapide 1,5×</option>
                </select>
              </label>
            ) : null}
          </div>

          {isHandoff ? (
            <p className="switch-warning">
              Pupitre générera avec <code>{conversation.model}</code> un débrief versionné, l’épinglera
              dans ce fil, puis initialisera une conversation {provider} avec ce contexte.
              Les deux fils resteront liés.
            </p>
          ) : (
            <p className="switch-warning">
              Le changement conserve ce fil, mais le cache du modèle sera perdu. Environ{' '}
              <strong>{tokenEstimate.toLocaleString('fr-FR')} tokens</strong> pourront être
              ré-ingérés au prochain tour.
            </p>
          )}

          {error ? <p className="modal-error" role="alert">{error}</p> : null}

          <footer>
            <button
              type="button"
              className="secondary-button"
              onClick={onClose}
              disabled={isSubmitting}
            >
              Annuler
            </button>
            <button type="submit" className="primary-button" disabled={isSubmitting}>
              {isSubmitting
                ? isHandoff ? 'Passation…' : 'Application…'
                : isHandoff ? `Passer à ${provider}` : 'Appliquer'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  )
}
