import { useEffect, useRef, useState } from 'react'
import {
  createPreset,
  deletePreset,
  listPresets,
  restorePreset,
  setProjectDefaultPreset,
  updatePreset,
} from './api'
import { HelpLink } from './HelpLink'
import {
  DELEGATION_ROUTING,
  MAX_CONCURRENT_SUBTASKS,
  MODEL_HINTS,
  PROVIDER_EFFORTS,
  PROVIDER_MODELS,
} from './modelOptions'
import { QuotaMeter } from './QuotaMeter'
import { shouldPulse } from './quotaSignals'
import { useNow } from './useNow'
import type {
  ConversationSpeed,
  Preset,
  Project,
  Provider,
  QuotaSnapshot,
} from './types'

/** Les cinq décisions que porte une conversation, sans son texte. */
export interface ConversationConfig {
  provider: Provider
  model: string
  effort: string
  speed: ConversationSpeed
  orchestrator: boolean
}

interface ConfigPanelProps {
  project: Project
  quotas: QuotaSnapshot
  config: ConversationConfig
  onConfigChange: (config: ConversationConfig) => void
  onProjectUpdated: (project: Project) => void
  onError: (message: string) => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Une erreur est survenue.'
}

function configOf(preset: Preset): ConversationConfig {
  return {
    provider: preset.provider,
    model: preset.model,
    effort: preset.effort ?? 'high',
    speed: preset.speed ?? 'standard',
    orchestrator: preset.orchestrator,
  }
}

/** La vitesse n'existe que côté codex : la comparaison doit l'ignorer ailleurs. */
function sameConfig(left: ConversationConfig, right: ConversationConfig): boolean {
  return left.provider === right.provider
    && left.model === right.model
    && left.effort === right.effort
    && left.orchestrator === right.orchestrator
    && (left.provider === 'codex' ? left.speed === right.speed : true)
}

type MenuAction = 'rename' | 'save-as' | null

/**
 * Carte de configuration affichée avant le premier message : le preset et les
 * cinq réglages qu'il porte. Tous les presets sont modifiables, y compris les
 * trois livrés avec Pupitre — eux seuls savent revenir à leurs valeurs d'usine.
 */
export function ConfigPanel({
  project,
  quotas,
  config,
  onConfigChange,
  onProjectUpdated,
  onError,
}: ConfigPanelProps) {
  const [presets, setPresets] = useState<Preset[]>([])
  const [selectedPresetId, setSelectedPresetId] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [action, setAction] = useState<MenuAction>(null)
  const [draftName, setDraftName] = useState('')
  const [isBusy, setIsBusy] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const now = useNow()

  const selectedPreset = presets.find((preset) => preset.id === selectedPresetId) ?? null
  const isDefault = (project.default_preset_id ?? '') === selectedPresetId && selectedPresetId !== ''
  // « Modifié » : le preset est choisi mais les réglages ne sont plus les siens.
  const isDirty = selectedPreset !== null && !sameConfig(config, configOf(selectedPreset))

  useEffect(() => {
    const abortController = new AbortController()
    void listPresets(abortController.signal)
      .then((loaded) => {
        setPresets(loaded)
        const projectDefault = loaded.find(
          (preset) => preset.id === project.default_preset_id,
        )
        if (projectDefault) {
          setSelectedPresetId(projectDefault.id)
          onConfigChange(configOf(projectDefault))
        }
      })
      .catch((error: unknown) => {
        if (!abortController.signal.aborted) onError(errorMessage(error))
      })
    return () => abortController.abort()
  }, [project.default_preset_id])

  // Un menu ouvert doit se refermer au clic ailleurs, sinon il masque la config.
  useEffect(() => {
    if (!menuOpen) return
    function onPointerDown(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    function onEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onEscape)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onEscape)
    }
  }, [menuOpen])

  /** Toute modification manuelle détache la config du preset choisi. */
  function patch(change: Partial<ConversationConfig>) {
    onConfigChange({ ...config, ...change })
  }

  function handleProviderChange(provider: Provider) {
    if (provider === config.provider) return
    onConfigChange({
      provider,
      model: PROVIDER_MODELS[provider][0],
      effort: 'high',
      speed: 'standard',
      orchestrator: config.orchestrator,
    })
  }

  function handlePresetChange(id: string) {
    setSelectedPresetId(id)
    const preset = presets.find((candidate) => candidate.id === id)
    if (preset) onConfigChange(configOf(preset))
  }

  function replace(updated: Preset) {
    setPresets((current) =>
      current.map((preset) => (preset.id === updated.id ? updated : preset)),
    )
  }

  async function run(task: () => Promise<void>) {
    if (isBusy) return
    setIsBusy(true)
    try {
      await task()
    } catch (error: unknown) {
      onError(errorMessage(error))
    } finally {
      setIsBusy(false)
    }
  }

  /** Écrit les réglages courants dans le preset sélectionné. */
  function handleApplyToPreset() {
    if (!selectedPreset) return
    setMenuOpen(false)
    void run(async () => {
      replace(await updatePreset(selectedPreset.id, {
        name: selectedPreset.name,
        provider: config.provider,
        model: config.model,
        effort: config.effort,
        speed: config.provider === 'codex' ? config.speed : null,
        orchestrator: config.orchestrator,
      }))
    })
  }

  function handleRename() {
    const name = draftName.trim()
    if (!selectedPreset || !name) return
    void run(async () => {
      replace(await updatePreset(selectedPreset.id, {
        name,
        provider: selectedPreset.provider,
        model: selectedPreset.model,
        effort: selectedPreset.effort,
        speed: selectedPreset.speed,
        orchestrator: selectedPreset.orchestrator,
      }))
      setAction(null)
      setDraftName('')
    })
  }

  function handleSaveAs() {
    const name = draftName.trim()
    if (!name) return
    void run(async () => {
      const created = await createPreset({
        name,
        provider: config.provider,
        model: config.model,
        effort: config.effort,
        speed: config.provider === 'codex' ? config.speed : null,
        orchestrator: config.orchestrator,
      })
      setPresets((current) => [...current, created])
      setSelectedPresetId(created.id)
      setAction(null)
      setDraftName('')
    })
  }

  function handleRestore() {
    if (!selectedPreset) return
    setMenuOpen(false)
    void run(async () => {
      const restored = await restorePreset(selectedPreset.id)
      replace(restored)
      onConfigChange(configOf(restored))
    })
  }

  function handleToggleDefault() {
    setMenuOpen(false)
    void run(async () => {
      onProjectUpdated(await setProjectDefaultPreset(
        project.id,
        isDefault ? null : selectedPresetId || null,
      ))
    })
  }

  function handleDelete() {
    if (!selectedPreset || selectedPreset.built_in) return
    setMenuOpen(false)
    const removed = selectedPreset
    void run(async () => {
      await deletePreset(removed.id)
      setPresets((current) => current.filter((preset) => preset.id !== removed.id))
      setSelectedPresetId('')
      if (project.default_preset_id === removed.id) {
        onProjectUpdated({ ...project, default_preset_id: null })
      }
    })
  }

  function openAction(next: Exclude<MenuAction, null>) {
    setMenuOpen(false)
    setAction(next)
    setDraftName(next === 'rename' ? selectedPreset?.name ?? '' : '')
  }

  return (
    <section className="config-panel" aria-label="Configuration de la conversation">
      <header className="config-header">
        <h2>Configuration</h2>
        <div className="config-preset">
          <label className="sr-only" htmlFor="config-preset-select">
            Preset
          </label>
          <select
            id="config-preset-select"
            value={selectedPresetId}
            onChange={(event) => handlePresetChange(event.target.value)}
          >
            <option value="">Sans preset</option>
            {presets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name}
              </option>
            ))}
          </select>
          {isDefault ? <span className="config-badge">défaut</span> : null}
          {isDirty ? <span className="config-badge is-dirty">modifié</span> : null}

          <div className="config-menu-anchor" ref={menuRef}>
            <button
              type="button"
              className="config-menu-button"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label="Actions sur le preset"
              onClick={() => setMenuOpen((open) => !open)}
              disabled={isBusy}
            >
              <span aria-hidden="true">⋯</span>
            </button>
            {menuOpen ? (
              <div className="config-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => openAction('save-as')}
                >
                  Enregistrer comme nouveau preset
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={handleApplyToPreset}
                  disabled={!selectedPreset || !isDirty}
                  title={
                    selectedPreset === null
                      ? 'Aucun preset sélectionné'
                      : isDirty
                        ? undefined
                        : 'Les réglages sont déjà ceux du preset'
                  }
                >
                  Écraser {selectedPreset?.name ?? 'le preset'} avec ces réglages
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => openAction('rename')}
                  disabled={!selectedPreset}
                >
                  Renommer
                </button>
                <button type="button" role="menuitem" onClick={handleToggleDefault}>
                  {isDefault
                    ? 'Retirer le défaut du projet'
                    : 'Définir comme défaut du projet'}
                </button>
                {selectedPreset?.built_in ? (
                  <button type="button" role="menuitem" onClick={handleRestore}>
                    Restaurer les valeurs d’origine
                  </button>
                ) : null}
                {selectedPreset && !selectedPreset.built_in ? (
                  <button
                    type="button"
                    role="menuitem"
                    className="is-danger"
                    onClick={handleDelete}
                  >
                    Supprimer
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
          <HelpLink slug="presets" />
        </div>
      </header>

      {action !== null ? (
        <div className="config-inline-form">
          <label htmlFor="config-preset-name">
            {action === 'rename' ? 'Nouveau nom' : 'Nom du preset'}
          </label>
          <input
            id="config-preset-name"
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setAction(null)
              if (event.key !== 'Enter') return
              event.preventDefault()
              if (action === 'rename') handleRename()
              else handleSaveAs()
            }}
            placeholder={action === 'rename' ? 'Éco' : 'Ma config'}
            autoFocus
          />
          <button
            type="button"
            className="config-primary"
            disabled={!draftName.trim() || isBusy}
            onClick={() => (action === 'rename' ? handleRename() : handleSaveAs())}
          >
            {action === 'rename' ? 'Renommer' : 'Enregistrer'}
          </button>
          <button type="button" className="config-ghost" onClick={() => setAction(null)}>
            Annuler
          </button>
        </div>
      ) : null}

      <div className="config-field">
        <span className="config-label">Provider</span>
        <div className="segmented" role="radiogroup" aria-label="Provider">
          {(Object.keys(PROVIDER_MODELS) as Provider[]).map((name) => (
            <button
              type="button"
              key={name}
              role="radio"
              aria-checked={config.provider === name}
              className={config.provider === name ? 'is-selected' : ''}
              onClick={() => handleProviderChange(name)}
            >
              {name}
            </button>
          ))}
        </div>
        <QuotaMeter provider={config.provider} state={quotas[config.provider]} />
      </div>

      <div className="config-field">
        <span className="config-label" id="config-model-label">Modèle</span>
        <div className="model-grid" role="radiogroup" aria-labelledby="config-model-label">
          {PROVIDER_MODELS[config.provider].map((name) => {
            // Pulse « use it or lose it » : quota peu entamé et fenêtre qui
            // expire dans l'heure → on pousse les modèles chers.
            const pulses = shouldPulse(quotas[config.provider], name, now)
            return (
              <button
                type="button"
                key={name}
                role="radio"
                aria-checked={config.model === name}
                className={`model-card${config.model === name ? ' is-selected' : ''}${pulses ? ' is-pulsing' : ''}`}
                onClick={() => patch({ model: name })}
                title={pulses ? 'Quota peu entamé et bientôt réinitialisé' : undefined}
              >
                <span className="model-card-name">{name}</span>
                <span className="model-card-hint">{MODEL_HINTS[name] ?? ''}</span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="config-field">
        <span className="config-label" id="config-effort-label">Effort</span>
        <div className="segmented" role="radiogroup" aria-labelledby="config-effort-label">
          {PROVIDER_EFFORTS[config.provider].map((name) => (
            <button
              type="button"
              key={name}
              role="radio"
              aria-checked={config.effort === name}
              className={config.effort === name ? 'is-selected' : ''}
              onClick={() => patch({ effort: name })}
            >
              {name}
            </button>
          ))}
        </div>
      </div>

      {config.provider === 'codex' ? (
        <div className="config-field">
          <span className="config-label" id="config-speed-label">Vitesse</span>
          <div className="segmented" role="radiogroup" aria-labelledby="config-speed-label">
            {([
              ['standard', 'Standard'],
              ['fast', 'Rapide 1,5×'],
            ] as const).map(([value, label]) => (
              <button
                type="button"
                key={value}
                role="radio"
                aria-checked={config.speed === value}
                className={config.speed === value ? 'is-selected' : ''}
                onClick={() => patch({ speed: value })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="config-field">
        <span className="config-label">Sub-agents</span>
        <label className="config-switch">
          <input
            type="checkbox"
            checked={config.orchestrator}
            onChange={(event) => patch({ orchestrator: event.target.checked })}
          />
          <span className="config-switch-track" aria-hidden="true" />
          <span>Autoriser la délégation à des sub-agents</span>
        </label>
        <HelpLink slug="orchestration" />
      </div>

      {config.orchestrator ? <DelegationPool /> : null}
    </section>
  )
}

/**
 * Ce que la délégation ouvre concrètement. Le modèle principal n'a pas de liste
 * de sub-agents imposée : il choisit lui-même, pour chaque sous-tâche, dans les
 * deux abonnements. On montre donc le pool réellement atteignable et le routage
 * recommandé, plutôt qu'une liste qui laisserait croire à un choix déjà fait.
 */
function DelegationPool() {
  return (
    <div className="delegation-pool">
      <p className="delegation-lead">
        Le modèle principal choisit lui-même ses sub-agents, sous-tâche par
        sous-tâche, dans les deux abonnements :
      </p>
      <div className="delegation-providers">
        {(Object.keys(PROVIDER_MODELS) as Provider[]).map((name) => (
          <div className="delegation-provider" key={name}>
            <span className="delegation-provider-name">{name}</span>
            <span className="delegation-models">
              {PROVIDER_MODELS[name].join(' · ')}
            </span>
          </div>
        ))}
      </div>
      <p className="delegation-note">
        Routage recommandé pour l’exécution :{' '}
        <strong>
          {DELEGATION_ROUTING.provider} · {DELEGATION_ROUTING.model}
        </strong>
        {' '}(effort {DELEGATION_ROUTING.effort}, {DELEGATION_ROUTING.speed}).
        Les gros modèles restent pour la conception et la revue. Maximum{' '}
        {MAX_CONCURRENT_SUBTASKS} sous-tâches simultanées ; un sub-agent ne peut
        pas déléguer à son tour.
      </p>
    </div>
  )
}
