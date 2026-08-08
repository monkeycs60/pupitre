import { useState } from 'react'
import type { FormEvent } from 'react'
import {
  createHandoffConversation,
  createHandoffDocument,
  type HandoffDocument,
} from './api'
import { PROVIDER_EFFORTS, PROVIDER_MODELS } from './modelOptions'
import Markdown from './Markdown'
import type { Conversation, ConversationSpeed, Provider } from './types'

interface HandoffModalProps {
  conversation: Conversation
  onClose: () => void
  onCreated: (conversation: Conversation) => void
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  const input = document.createElement('textarea')
  input.value = text
  input.style.position = 'fixed'
  input.style.opacity = '0'
  document.body.appendChild(input)
  input.select()
  const copied = document.execCommand('copy')
  input.remove()
  if (!copied) throw new Error('copie refusée')
}

function downloadDocument(handoff: HandoffDocument): void {
  const blob = new Blob([handoff.contentMd], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = handoff.filename
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Une erreur est survenue.'
}

export function HandoffModal({ conversation, onClose, onCreated }: HandoffModalProps) {
  const [handoff, setHandoff] = useState<HandoffDocument | null>(null)
  const [provider, setProvider] = useState<Provider>(conversation.provider)
  const [model, setModel] = useState(conversation.model)
  const [effort, setEffort] = useState(conversation.effort ?? 'high')
  const [speed, setSpeed] = useState<ConversationSpeed>(conversation.speed ?? 'standard')
  const [isGenerating, setIsGenerating] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleGenerate() {
    if (isGenerating || isCreating) return
    setIsGenerating(true)
    setError(null)
    try {
      setHandoff(await createHandoffDocument(conversation.id))
    } catch (generationError: unknown) {
      setError(errorMessage(generationError))
    } finally {
      setIsGenerating(false)
    }
  }

  async function handleCopy() {
    if (handoff === null) return
    try {
      await copyText(handoff.contentMd)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1_500)
    } catch (copyError: unknown) {
      setError(errorMessage(copyError))
    }
  }

  async function handleCreateConversation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (handoff === null || isCreating) return
    setIsCreating(true)
    setError(null)
    try {
      onCreated(await createHandoffConversation(conversation.id, {
        provider,
        model,
        effort,
        speed: provider === 'codex' ? speed : null,
        orchestrator: conversation.orchestrator,
      }))
    } catch (creationError: unknown) {
      setError(errorMessage(creationError))
      setIsCreating(false)
    }
  }

  function handleProviderChange(nextProvider: Provider) {
    setProvider(nextProvider)
    setModel(PROVIDER_MODELS[nextProvider][0])
    setEffort('high')
    setSpeed('standard')
  }

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={() => { if (!isGenerating && !isCreating) onClose() }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !isGenerating && !isCreating) onClose()
      }}
    >
      <section
        className="handoff-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="handoff-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="handoff-modal-header">
          <div>
            <h2 id="handoff-title">Handoff de session</h2>
            <p>Prépare le transfert complet de la session vers une nouvelle conversation.</p>
          </div>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            aria-label="Fermer"
            disabled={isGenerating || isCreating}
          >
            ×
          </button>
        </header>

        {handoff === null ? (
          <div className="handoff-modal-body">
            <p className="handoff-modal-note">
              Le handoff conserve le débrief complet de la session. Il ne modifie pas le projet.
            </p>
            <div className="handoff-modal-actions">
              <button
                type="button"
                className="primary-button"
                onClick={() => void handleGenerate()}
                disabled={isGenerating}
              >
                {isGenerating ? 'Génération…' : 'Générer le document'}
              </button>
            </div>
          </div>
        ) : (
          <form className="handoff-modal-body" onSubmit={(event) => void handleCreateConversation(event)}>
            <div className="handoff-preview" aria-label="Aperçu du document de handoff">
              <Markdown>{handoff.contentMd}</Markdown>
            </div>

            <div className="handoff-modal-actions handoff-export-actions">
              <button type="button" className="secondary-button" onClick={() => void handleCopy()}>
                {copied ? 'Copié' : 'Copier'}
              </button>
              <button type="button" className="secondary-button" onClick={() => downloadDocument(handoff)}>
                Enregistrer
              </button>
            </div>

            <div className="handoff-target-fields">
              <h3>Créer une conversation à partir du handoff</h3>
              <div className="switch-fields">
                <label>
                  <span>Provider</span>
                  <select
                    value={provider}
                    onChange={(event) => handleProviderChange(event.target.value as Provider)}
                  >
                    <option value="claude">claude</option>
                    <option value="codex">codex</option>
                  </select>
                </label>
                <label>
                  <span>Modèle</span>
                  <select className="field-mono" value={model} onChange={(event) => setModel(event.target.value)}>
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
                    <select value={speed} onChange={(event) => setSpeed(event.target.value as ConversationSpeed)}>
                      <option value="standard">Standard</option>
                      <option value="fast">Rapide 1,5×</option>
                    </select>
                  </label>
                ) : null}
              </div>
            </div>

            {error !== null ? <p className="modal-error" role="alert">{error}</p> : null}

            <footer className="handoff-modal-footer">
              <button type="button" className="secondary-button" onClick={onClose} disabled={isCreating}>
                Fermer
              </button>
              <button type="submit" className="primary-button" disabled={isCreating}>
                {isCreating ? 'Création…' : 'Créer la conversation'}
              </button>
            </footer>
          </form>
        )}

        {handoff === null && error !== null ? (
          <p className="modal-error handoff-modal-error" role="alert">{error}</p>
        ) : null}
      </section>
    </div>
  )
}
