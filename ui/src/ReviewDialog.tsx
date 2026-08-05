import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { listPresets, startReview, updatePreset } from './api'
import { PROVIDER_EFFORTS, REVIEW_MODELS } from './modelOptions'
import type { Conversation, Preset, Project, Provider, Review } from './types'

interface ReviewDialogProps {
  conversation: Conversation
  project: Project
  onClose: () => void
  onStarted: (review: Review) => void
}

function defaultReview(provider: Provider) {
  return provider === 'claude'
    ? { provider, model: 'opus', effort: 'high' }
    : { provider, model: 'gpt-5.6-sol', effort: 'high' }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Impossible de lancer la review.'
}

export function ReviewDialog({
  conversation,
  project,
  onClose,
  onStarted,
}: ReviewDialogProps) {
  const initial = defaultReview(conversation.provider)
  const [provider, setProvider] = useState<Provider>(initial.provider)
  const [model, setModel] = useState(initial.model)
  const [effort, setEffort] = useState(initial.effort)
  const [codeProvider, setCodeProvider] = useState<Provider>(conversation.provider)
  const [gitRefBase, setGitRefBase] = useState('CONVERSATION')
  const [gitRefHead, setGitRefHead] = useState('WORKTREE')
  const [presets, setPresets] = useState<Preset[]>([])
  const [selectedPresetId, setSelectedPresetId] = useState(project.default_preset_id ?? '')
  const [remember, setRemember] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const selectedPreset = presets.find((preset) => preset.id === selectedPresetId) ?? null

  useEffect(() => {
    const controller = new AbortController()
    void listPresets(controller.signal)
      .then((loaded) => {
        if (controller.signal.aborted) return
        setPresets(loaded)
        const preset = loaded.find((item) => item.id === project.default_preset_id)
        if (!preset) return
        setProvider(preset.review_provider)
        setModel(preset.review_model)
        setEffort(preset.review_effort)
      })
      .catch((loadError: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(loadError))
      })
    return () => controller.abort()
  }, [project.default_preset_id])

  function applyPreset(preset: Preset | null) {
    setSelectedPresetId(preset?.id ?? '')
    setRemember(false)
    if (preset) {
      setProvider(preset.review_provider)
      setModel(preset.review_model)
      setEffort(preset.review_effort)
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (isSubmitting) return
    setIsSubmitting(true)
    setError(null)
    try {
      if (remember && selectedPreset && !selectedPreset.built_in) {
        const updated = await updatePreset(selectedPreset.id, {
          name: selectedPreset.name,
          provider: selectedPreset.provider,
          model: selectedPreset.model,
          effort: selectedPreset.effort,
          speed: selectedPreset.speed,
          orchestrator: selectedPreset.orchestrator,
          review_provider: provider,
          review_model: model,
          review_effort: effort,
        })
        setPresets((current) => current.map((preset) =>
          preset.id === updated.id ? updated : preset,
        ))
      }
      onStarted(await startReview({
        conversationId: conversation.id,
        gitRefBase: gitRefBase.trim(),
        gitRefHead: gitRefHead.trim(),
        presetId: selectedPresetId || null,
        reviewProvider: provider,
        reviewModel: model,
        reviewEffort: effort,
        codeProvider,
      }))
    } catch (submitError: unknown) {
      setError(errorMessage(submitError))
      setIsSubmitting(false)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="modal review-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="review-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div>
            <h2 id="review-dialog-title">Review Gardien</h2>
            <p>{conversation.title}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Fermer">×</button>
        </header>

        <form className="review-dialog-form" onSubmit={(event) => void handleSubmit(event)}>
          <label>
            <span>Preset</span>
            <select
              value={selectedPresetId}
              onChange={(event) => applyPreset(
                presets.find((preset) => preset.id === event.target.value) ?? null,
              )}
            >
              <option value="">Configuration manuelle</option>
              {presets.map((preset) => (
                <option key={preset.id} value={preset.id}>{preset.name}</option>
              ))}
            </select>
          </label>

          <div className="review-dialog-grid">
            <label>
              <span>Provider auteur du code</span>
              <select
                value={codeProvider}
                onChange={(event) => setCodeProvider(event.target.value as Provider)}
              >
                <option value="codex">codex</option>
                <option value="claude">claude</option>
              </select>
            </label>
            <label>
              <span>Provider de review</span>
              <select
                value={provider}
                onChange={(event) => {
                  const next = event.target.value as Provider
                  const defaults = defaultReview(next)
                  setProvider(next)
                  setModel(defaults.model)
                  setEffort(defaults.effort)
                  setRemember(false)
                }}
              >
                <option value="codex">codex</option>
                <option value="claude">claude</option>
              </select>
            </label>
            <label>
              <span>Modèle fort</span>
              <select value={model} onChange={(event) => setModel(event.target.value)}>
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
          </div>

          <div className="review-dialog-grid refs">
            <label>
              <span>Référence de base</span>
              <input value={gitRefBase} onChange={(event) => setGitRefBase(event.target.value)} required />
            </label>
            <label>
              <span>Référence de tête</span>
              <input value={gitRefHead} onChange={(event) => setGitRefHead(event.target.value)} required />
            </label>
          </div>

          {selectedPreset && !selectedPreset.built_in ? (
            <label className="review-remember">
              <input
                type="checkbox"
                checked={remember}
                onChange={(event) => setRemember(event.target.checked)}
              />
              <span>Mémoriser ce reviewer dans « {selectedPreset.name} »</span>
            </label>
          ) : null}

          <p className="review-dialog-note">
            Le Gardien lit le diff en sandbox lecture seule. Le pré-découpage est
            déterministe ; seul le modèle fort juge les risques. Si un sub-agent a
            écrit le diff, indiquez son provider comme auteur pour garantir un
            contre-avis réellement croisé. Par défaut, « CONVERSATION → WORKTREE »
            couvre tous les commits attribués à ce fil ainsi que les changements
            indexés, non indexés et les nouveaux fichiers.
          </p>
          {error ? <p className="modal-error" role="alert">{error}</p> : null}

          <footer className="modal-actions">
            <button type="button" className="secondary-button" onClick={onClose}>Annuler</button>
            <button type="submit" className="primary-button" disabled={isSubmitting}>
              {isSubmitting ? 'Lancement…' : 'Lancer la review'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  )
}
