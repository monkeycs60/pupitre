import { useState } from 'react'
import type {
  ChangeEvent,
  ClipboardEvent,
  FormEvent,
  KeyboardEvent,
} from 'react'
import {
  ApiError,
  cancelConversation,
  createConversation,
  sendMessage,
  uploadMedia,
} from './api'
import type { Conversation, Provider } from './types'

export const PROVIDER_MODELS = {
  claude: ['fable-5', 'opus', 'sonnet', 'haiku'],
  codex: ['gpt-5.6-sol', 'gpt-5.6-luna'],
} as const satisfies Record<Provider, readonly string[]>

export const PROVIDER_EFFORTS = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh'],
} as const satisfies Record<Provider, readonly string[]>

interface ComposerProps {
  conversationId: string | null
  projectId: string
  isRunning: boolean
  onConversationCreated: (conversation: Conversation) => void
}

interface UploadedImage {
  id: string
  name: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Une erreur est survenue.'
}

function mediaUrl(name: string): string {
  return `/media/${encodeURIComponent(name)}`
}

export function Composer({
  conversationId,
  projectId,
  isRunning,
  onConversationCreated,
}: ComposerProps) {
  const [message, setMessage] = useState('')
  const [provider, setProvider] = useState<Provider>('claude')
  const [model, setModel] = useState<string>(PROVIDER_MODELS.claude[0])
  const [effort, setEffort] = useState<string>('high')
  const [images, setImages] = useState<UploadedImage[]>([])
  const [pendingUploads, setPendingUploads] = useState(0)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isCancelling, setIsCancelling] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const isNewConversation = conversationId === null
  const canSubmit =
    message.trim().length > 0 &&
    pendingUploads === 0 &&
    !isSubmitting &&
    !isRunning

  function handleProviderChange(event: ChangeEvent<HTMLSelectElement>) {
    const nextProvider = event.target.value as Provider
    setProvider(nextProvider)
    setModel(PROVIDER_MODELS[nextProvider][0])
    setEffort('high')
  }

  async function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const imageFiles = Array.from(event.clipboardData.items).flatMap((item) => {
      if (item.kind !== 'file' || !item.type.startsWith('image/')) return []
      const file = item.getAsFile()
      return file === null ? [] : [file]
    })

    if (imageFiles.length === 0) return

    event.preventDefault()
    setToast(null)
    setPendingUploads((current) => current + imageFiles.length)

    const results = await Promise.allSettled(imageFiles.map(uploadMedia))
    const uploaded = results.flatMap((result) =>
      result.status === 'fulfilled'
        ? [{ id: crypto.randomUUID(), name: result.value.name }]
        : [],
    )

    if (uploaded.length > 0) {
      setImages((current) => [...current, ...uploaded])
    }
    if (uploaded.length !== imageFiles.length) {
      setToast('Impossible de téléverser une image.')
    }
    setPendingUploads((current) => current - imageFiles.length)
  }

  async function handleSubmit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault()
    const trimmedMessage = message.trim()
    if (!trimmedMessage || !canSubmit) return

    setIsSubmitting(true)
    setToast(null)
    const imageNames = images.map((image) => image.name)

    try {
      if (conversationId === null) {
        const conversation = await createConversation({
          projectId,
          provider,
          model,
          effort,
          message: trimmedMessage,
          images: imageNames,
        })
        onConversationCreated(conversation)
      } else {
        await sendMessage(conversationId, {
          message: trimmedMessage,
          images: imageNames,
        })
        setMessage('')
        setImages([])
      }
    } catch (error: unknown) {
      if (error instanceof ApiError && error.status === 409) {
        setToast('un tour est déjà en cours')
      } else {
        setToast(errorMessage(error))
      }
    } finally {
      setIsSubmitting(false)
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) {
      return
    }

    event.preventDefault()
    void handleSubmit()
  }

  async function handleCancel() {
    if (conversationId === null || isCancelling) return

    setIsCancelling(true)
    setToast(null)
    try {
      await cancelConversation(conversationId)
    } catch (error: unknown) {
      setToast(errorMessage(error))
    } finally {
      setIsCancelling(false)
    }
  }

  return (
    <div className="composer-area">
      {toast !== null ? (
        <div className="composer-toast" role="alert">
          <span>{toast}</span>
          <button
            type="button"
            onClick={() => setToast(null)}
            aria-label="Fermer la notification"
          >
            ×
          </button>
        </div>
      ) : null}

      <form className="composer" onSubmit={(event) => void handleSubmit(event)}>
        {isNewConversation ? (
          <div className="composer-models">
            <label>
              <span>Provider</span>
              <select value={provider} onChange={handleProviderChange}>
                {Object.keys(PROVIDER_MODELS).map((providerName) => (
                  <option key={providerName} value={providerName}>
                    {providerName}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span>Modèle</span>
              <select
                value={model}
                onChange={(event) => setModel(event.target.value)}
              >
                {PROVIDER_MODELS[provider].map((modelName) => (
                  <option key={modelName} value={modelName}>
                    {modelName}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span>Effort</span>
              <select
                value={effort}
                onChange={(event) => setEffort(event.target.value)}
              >
                {PROVIDER_EFFORTS[provider].map((effortName) => (
                  <option key={effortName} value={effortName}>
                    {effortName}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : null}

        {images.length > 0 || pendingUploads > 0 ? (
          <div className="composer-images" aria-label="Images jointes">
            {images.map((image) => (
              <div className="composer-image" key={image.id}>
                <img src={mediaUrl(image.name)} alt="Image jointe" />
                <button
                  type="button"
                  onClick={() =>
                    setImages((current) =>
                      current.filter((item) => item.id !== image.id),
                    )
                  }
                  aria-label="Retirer l’image"
                  title="Retirer l’image"
                >
                  ×
                </button>
              </div>
            ))}
            {pendingUploads > 0 ? (
              <span className="composer-uploading">Import en cours…</span>
            ) : null}
          </div>
        ) : null}

        <textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={(event) => void handlePaste(event)}
          placeholder={isRunning ? 'tour en cours…' : 'Écrivez un message…'}
          aria-label="Message"
          rows={3}
          disabled={isRunning}
          autoFocus={isNewConversation}
        />

        <div className="composer-actions">
          <span>Entrée pour envoyer · Shift+Entrée pour une nouvelle ligne</span>
          <div>
            {isRunning && conversationId !== null ? (
              <button
                type="button"
                className="cancel-button"
                onClick={() => void handleCancel()}
                disabled={isCancelling}
              >
                {isCancelling ? 'Annulation…' : 'Annuler'}
              </button>
            ) : null}
            <button type="submit" className="send-button" disabled={!canSubmit}>
              {isSubmitting
                ? isNewConversation
                  ? 'Création…'
                  : 'Envoi…'
                : 'Envoyer'}
            </button>
          </div>
        </div>
      </form>
    </div>
  )
}
