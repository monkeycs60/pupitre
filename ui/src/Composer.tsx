import { useEffect, useState } from 'react'
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
  createPreset,
  deletePreset,
  listPresets,
  sendMessage,
  setProjectDefaultPreset,
  uploadMedia,
} from './api'
import { buildCreateConversationInput } from './conversationDraft'
import { quotaChipLabel, shouldPulse } from './quotaSignals'
import type {
  Conversation,
  ConversationSpeed,
  Preset,
  Project,
  Provider,
  QuotaSnapshot,
} from './types'
import { useNow } from './useNow'
import { PROVIDER_EFFORTS, PROVIDER_MODELS } from './modelOptions'
import { mediaUrl } from './transport'

interface ComposerProps {
  conversationId: string | null
  project: Project
  quotas: QuotaSnapshot
  isRunning: boolean
  onConversationCreated: (conversation: Conversation) => void
  onProjectUpdated: (project: Project) => void
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
}: ComposerProps) {
  const [message, setMessage] = useState('')
  const [provider, setProvider] = useState<Provider>('claude')
  const [model, setModel] = useState<string>(PROVIDER_MODELS.claude[0])
  const [effort, setEffort] = useState<string>('high')
  const [speed, setSpeed] = useState<ConversationSpeed>('standard')
  const [orchestrator, setOrchestrator] = useState(true)
  const [presets, setPresets] = useState<Preset[]>([])
  const [selectedPresetId, setSelectedPresetId] = useState('')
  const [presetName, setPresetName] = useState('')
  const [isSavingPreset, setIsSavingPreset] = useState(false)
  const [images, setImages] = useState<UploadedImage[]>([])
  const [pendingUploads, setPendingUploads] = useState(0)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isCancelling, setIsCancelling] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const now = useNow()
  const providerQuota = quotas[provider]
  // Tous les modèles de la liste partagent le provider sélectionné : la chip est
  // donc l'état de CE provider, répété en face de chaque modèle.
  const chip = quotaChipLabel(providerQuota, now)
  const isNewConversation = conversationId === null
  const canSubmit =
    message.trim().length > 0 &&
    pendingUploads === 0 &&
    !isSubmitting &&
    !isRunning

  const selectedPreset = presets.find((preset) => preset.id === selectedPresetId)

  function applyPreset(preset: Preset) {
    setProvider(preset.provider)
    setModel(preset.model)
    setEffort(preset.effort ?? 'high')
    setSpeed(preset.speed ?? 'standard')
    setOrchestrator(preset.orchestrator)
    setSelectedPresetId(preset.id)
  }

  useEffect(() => {
    if (!isNewConversation) return
    const abortController = new AbortController()
    void listPresets(abortController.signal)
      .then((loaded) => {
        setPresets(loaded)
        const projectDefault = loaded.find(
          (preset) => preset.id === project.default_preset_id,
        )
        if (projectDefault) applyPreset(projectDefault)
      })
      .catch((error: unknown) => {
        if (!abortController.signal.aborted) setToast(errorMessage(error))
      })
    return () => abortController.abort()
  }, [isNewConversation, project.default_preset_id])

  function handleProviderChange(event: ChangeEvent<HTMLSelectElement>) {
    const nextProvider = event.target.value as Provider
    setProvider(nextProvider)
    setModel(PROVIDER_MODELS[nextProvider][0])
    setEffort('high')
    setSpeed('standard')
    setSelectedPresetId('')
  }

  function handlePresetChange(event: ChangeEvent<HTMLSelectElement>) {
    const preset = presets.find((candidate) => candidate.id === event.target.value)
    if (preset) applyPreset(preset)
    else setSelectedPresetId('')
  }

  async function handleSavePreset() {
    const name = presetName.trim()
    if (!name || isSavingPreset) return
    setIsSavingPreset(true)
    setToast(null)
    try {
      const created = await createPreset({
        name,
        provider,
        model,
        effort,
        speed: provider === 'codex' ? speed : null,
        orchestrator,
      })
      setPresets((current) => [...current, created])
      setSelectedPresetId(created.id)
      setPresetName('')
    } catch (error: unknown) {
      setToast(errorMessage(error))
    } finally {
      setIsSavingPreset(false)
    }
  }

  async function handleDefaultPreset() {
    setToast(null)
    try {
      const updated = await setProjectDefaultPreset(
        project.id,
        selectedPresetId || null,
      )
      onProjectUpdated(updated)
    } catch (error: unknown) {
      setToast(errorMessage(error))
    }
  }

  async function handleDeletePreset() {
    if (!selectedPreset || selectedPreset.built_in) return
    setToast(null)
    try {
      await deletePreset(selectedPreset.id)
      setPresets((current) => current.filter((preset) => preset.id !== selectedPreset.id))
      setSelectedPresetId('')
      if (project.default_preset_id === selectedPreset.id) {
        onProjectUpdated({ ...project, default_preset_id: null })
      }
    } catch (error: unknown) {
      setToast(errorMessage(error))
    }
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
        const conversation = await createConversation(buildCreateConversationInput({
          projectId: project.id,
          provider,
          model,
          effort,
          speed,
          orchestrator,
          message: trimmedMessage,
          images: imageNames,
        }))
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
            <div className="preset-controls">
              <label>
                <span>Preset</span>
                <select value={selectedPresetId} onChange={handlePresetChange}>
                  <option value="">Configuration manuelle</option>
                  {presets.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.name}{preset.built_in ? '' : ' · perso'}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="preset-secondary"
                onClick={() => void handleDefaultPreset()}
                disabled={(project.default_preset_id ?? '') === selectedPresetId}
              >
                {(project.default_preset_id ?? '') === selectedPresetId
                  ? selectedPresetId ? 'Défaut du projet' : 'Aucun défaut'
                  : selectedPresetId
                    ? 'Définir par défaut'
                    : 'Retirer le défaut'}
              </button>
              {selectedPreset && !selectedPreset.built_in ? (
                <button
                  type="button"
                  className="preset-danger"
                  onClick={() => void handleDeletePreset()}
                >
                  Supprimer
                </button>
              ) : null}
              <div className="preset-save">
                <input
                  value={presetName}
                  onChange={(event) => setPresetName(event.target.value)}
                  placeholder="Nom du preset"
                  aria-label="Nom du nouveau preset"
                />
                <button
                  type="button"
                  className="preset-secondary"
                  disabled={!presetName.trim() || isSavingPreset}
                  onClick={() => void handleSavePreset()}
                >
                  {isSavingPreset ? 'Enregistrement…' : 'Enregistrer la config'}
                </button>
              </div>
            </div>

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

            <div className="model-picker" role="radiogroup" aria-label="Modèle">
              <span className="model-picker-title">Modèle</span>
              {PROVIDER_MODELS[provider].map((modelName) => {
                // Pulse « use it or lose it » : quota largement dispo et fenêtre
                // qui expire dans l'heure → on pousse les modèles chers.
                const pulses = shouldPulse(providerQuota, modelName, now)
                return (
                  <button
                    type="button"
                    key={modelName}
                    role="radio"
                    aria-checked={model === modelName}
                    className={`model-option ${model === modelName ? 'is-selected' : ''} ${pulses ? 'is-pulsing' : ''}`}
                    onClick={() => {
                      setModel(modelName)
                      setSelectedPresetId('')
                    }}
                    title={pulses ? 'Quota peu entamé et bientôt réinitialisé' : undefined}
                  >
                    <span className="model-option-name">{modelName}</span>
                    <span
                      className={`quota-chip ${chip === null ? 'is-unknown' : ''}`}
                    >
                      {chip ?? 'quota inconnu'}
                    </span>
                  </button>
                )
              })}
            </div>

            <label>
              <span>Effort</span>
              <select
                value={effort}
                onChange={(event) => {
                  setEffort(event.target.value)
                  setSelectedPresetId('')
                }}
              >
                {PROVIDER_EFFORTS[provider].map((effortName) => (
                  <option key={effortName} value={effortName}>
                    {effortName}
                  </option>
                ))}
              </select>
            </label>

            {provider === 'codex' ? (
              <label>
                <span>Vitesse</span>
                <select
                  value={speed}
                  onChange={(event) => {
                    setSpeed(event.target.value as ConversationSpeed)
                    setSelectedPresetId('')
                  }}
                >
                  <option value="standard">Standard</option>
                  <option value="fast">Rapide 1,5×</option>
                </select>
              </label>
            ) : null}

            <label className="orchestrator-toggle">
              <input
                type="checkbox"
                checked={orchestrator}
                onChange={(event) => {
                  setOrchestrator(event.target.checked)
                  setSelectedPresetId('')
                }}
              />
              <span>Autoriser la délégation à des sub-agents</span>
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
