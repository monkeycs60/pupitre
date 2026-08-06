import { useState } from 'react'
import type { ClipboardEvent, FormEvent, KeyboardEvent } from 'react'
import {
  ApiError,
  cancelConversation,
  createDebrief,
  createTestInventory,
  createConversation,
  sendMessage,
  uploadMedia,
} from './api'
import { buildCreateConversationInput } from './conversationDraft'
import { ConfigPanel, type ConversationConfig } from './ConfigPanel'
import type { Conversation, Project, QuotaSnapshot } from './types'
import { PROVIDER_MODELS } from './modelOptions'
import { mediaUrl } from './transport'
import { HelpLink } from './HelpLink'

interface ComposerProps {
  conversationId: string | null
  project: Project
  quotas: QuotaSnapshot
  isRunning: boolean
  onConversationCreated: (conversation: Conversation) => void
  onProjectUpdated: (project: Project) => void
  message: string
  onMessageChange: (message: string) => void
  focusRequest: number
}

interface UploadedImage {
  id: string
  name: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Une erreur est survenue.'
}

export function Composer({
  conversationId,
  project,
  quotas,
  isRunning,
  onConversationCreated,
  onProjectUpdated,
  message,
  onMessageChange,
  focusRequest,
}: ComposerProps) {
  const [config, setConfig] = useState<ConversationConfig>({
    provider: 'claude',
    model: PROVIDER_MODELS.claude[0],
    effort: 'high',
    speed: 'standard',
    orchestrator: true,
  })
  const [images, setImages] = useState<UploadedImage[]>([])
  const [pendingUploads, setPendingUploads] = useState(0)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isCancelling, setIsCancelling] = useState(false)
  const [isCreatingDebrief, setIsCreatingDebrief] = useState(false)
  const [isCreatingTestInventory, setIsCreatingTestInventory] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const isNewConversation = conversationId === null
  const canSubmit =
    message.trim().length > 0 &&
    pendingUploads === 0 &&
    !isSubmitting &&
    !isRunning

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
        const conversation = await createConversation(buildCreateConversationInput({
          projectId: project.id,
          ...config,
          message: trimmedMessage,
          images: imageNames,
        }))
        onConversationCreated(conversation)
      } else {
        await sendMessage(conversationId, {
          message: trimmedMessage,
          images: imageNames,
        })
        onMessageChange('')
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

  async function handleDebrief() {
    if (conversationId === null || isCreatingDebrief || isRunning) return
    setIsCreatingDebrief(true)
    setToast(null)
    try {
      await createDebrief(conversationId)
      setToast('Débrief ajouté au fil.')
    } catch (error: unknown) {
      setToast(errorMessage(error))
    } finally {
      setIsCreatingDebrief(false)
    }
  }

  async function handleTestInventory() {
    if (conversationId === null || isCreatingTestInventory || isRunning) return
    setIsCreatingTestInventory(true)
    setToast(null)
    try {
      await createTestInventory(conversationId)
      setToast('Inventaire de test ajouté au fil.')
    } catch (error: unknown) {
      setToast(errorMessage(error))
    } finally {
      setIsCreatingTestInventory(false)
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
          <ConfigPanel
            project={project}
            quotas={quotas}
            config={config}
            onConfigChange={setConfig}
            onProjectUpdated={onProjectUpdated}
            onError={setToast}
          />
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
          key={`composer-message-${focusRequest}`}
          value={message}
          onChange={(event) => onMessageChange(event.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={(event) => void handlePaste(event)}
          placeholder={isRunning ? 'tour en cours…' : 'Écrivez un message…'}
          aria-label="Message"
          rows={3}
          disabled={isRunning}
          autoFocus={isNewConversation || focusRequest > 0}
        />

        <div className="composer-actions">
          <span>Entrée pour envoyer · Shift+Entrée pour une nouvelle ligne · <HelpLink slug="tester" label="Tester ?" /> · <HelpLink slug="debrief" label="Débrief ?" /></span>
          <div>
            {!isNewConversation ? (
              <button
                type="button"
                className="test-button"
                onClick={() => void handleTestInventory()}
                disabled={isRunning || isCreatingTestInventory || isSubmitting}
                title="Relire le travail, choisir un périmètre puis exécuter des tests avec preuves"
              >
                {isCreatingTestInventory ? 'Inventaire…' : 'Tester'}
              </button>
            ) : null}
            {!isNewConversation ? (
              <button
                type="button"
                className="debrief-button"
                onClick={() => void handleDebrief()}
                disabled={isRunning || isCreatingDebrief || isSubmitting}
                title="Créer un bilan versionné des décisions récentes pour reprendre le contrôle ou préparer une passation"
              >
                {isCreatingDebrief ? 'Débrief en cours…' : 'Reprendre le contrôle'}
              </button>
            ) : null}
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
