import { useState } from 'react'
import type { FormEvent } from 'react'
import {
  handoffConversation,
  switchConversationModel,
} from './api'
import { ConfigPanel, type ConversationConfig } from './ConfigPanel'
import { estimatedReingestionTokens } from './modelSwitch'
import type {
  AppEvent,
  Conversation,
  Project,
  QuotaSnapshot,
} from './types'

interface SwitchModelModalProps {
  conversation: Conversation
  events: AppEvent[]
  project: Project
  quotas: QuotaSnapshot
  onProjectUpdated: (project: Project) => void
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
  project,
  quotas,
  onProjectUpdated,
  onClose,
  onSwitched,
  onHandoff,
}: SwitchModelModalProps) {
  const [config, setConfig] = useState<ConversationConfig>({
    provider: conversation.provider,
    model: conversation.model,
    effort: conversation.effort ?? 'high',
    speed: conversation.speed ?? 'standard',
    permissionMode: conversation.permission_mode ?? null,
    orchestrator: conversation.orchestrator,
    subagentPresetId: conversation.subagent_preset_id ?? null,
    subagentEffort: conversation.subagent_effort ?? null,
  })
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isHandoff = config.provider !== conversation.provider
  const tokenEstimate = estimatedReingestionTokens(events)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setIsSubmitting(true)
    setError(null)
    const input = {
      provider: config.provider,
      model: config.model,
      effort: config.effort,
      speed: config.provider === 'codex' ? config.speed : null,
      orchestrator: conversation.orchestrator,
    }
    try {
      if (isHandoff) {
        onHandoff(await handoffConversation(conversation.id, input))
      } else {
        const result = await switchConversationModel(conversation.id, input)
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
          <ConfigPanel
            project={project}
            quotas={quotas}
            config={config}
            onConfigChange={setConfig}
            onProjectUpdated={onProjectUpdated}
            onError={setError}
            applyProjectDefault={false}
            showConversationSettings={false}
          />

          {isHandoff ? (
            <p className="switch-warning">
              Pupitre générera avec <code>{conversation.model}</code> un débrief versionné, l’épinglera
              dans ce fil, puis initialisera une conversation {config.provider} avec ce contexte.
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
                : isHandoff ? `Passer à ${config.provider}` : 'Appliquer'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  )
}
