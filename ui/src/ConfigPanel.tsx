import { useEffect, useRef, useState } from 'react'
import {
  createPreset,
  deletePreset,
  getProjectGit,
  listPresets,
  restorePreset,
  setProjectDefaultPreset,
  updatePreset,
} from './api'
import { ModelConfigSelector } from './ModelConfigSelector'
import { branchSuggestions } from './worktrees'
import type {
  ConversationSpeed,
  Preset,
  PresetPermissionMode,
  Project,
  Provider,
  QuotaSnapshot,
} from './types'

/** Les décisions de lancement d'une conversation, sans son premier message. */
export interface ConversationConfig {
  presetId?: string | null
  provider: Provider
  model: string
  effort: string
  speed: ConversationSpeed
  permissionMode: PresetPermissionMode | null
  orchestrator: boolean
  subagentPresetId: string | null
  subagentEffort: string | null
  /** Branche sur laquelle isoler la conversation ; vide = dépôt principal. */
  branch?: string | null
}

interface ConfigPanelProps {
  project: Project
  quotas: QuotaSnapshot
  config: ConversationConfig
  onConfigChange: (config: ConversationConfig) => void
  onProjectUpdated: (project: Project) => void
  onError: (message: string) => void
  onReady?: (ready: boolean) => void
  /** La modale de bascule conserve sa configuration au lieu du défaut projet. */
  applyProjectDefault?: boolean
  /** Les réglages de conversation exigent des routes dédiées après création. */
  showConversationSettings?: boolean
}

type MenuAction = 'rename' | 'save-as' | null

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Une erreur est survenue.'
}

function configOf(preset: Preset): ConversationConfig {
  return {
    presetId: preset.id,
    provider: preset.provider,
    model: preset.model,
    effort: preset.effort ?? 'high',
    speed: preset.speed ?? 'standard',
    permissionMode: preset.permission_mode ?? null,
    orchestrator: preset.orchestrator,
    subagentPresetId: preset.subagent_preset_id ?? null,
    subagentEffort: preset.subagent_effort ?? null,
  }
}

function sameConfig(left: ConversationConfig, right: ConversationConfig): boolean {
  return left.provider === right.provider
    && left.model === right.model
    && left.effort === right.effort
    && left.orchestrator === right.orchestrator
    && left.subagentPresetId === right.subagentPresetId
    && left.subagentEffort === right.subagentEffort
    && left.permissionMode === right.permissionMode
    && (left.provider === 'codex' ? left.speed === right.speed : true)
}

/**
 * Contrôleur des presets pour la création et la modale de bascule. Le rendu
 * lourd est dans ModelConfigSelector : ici restent uniquement les appels API.
 */
export function ConfigPanel({
  project,
  quotas,
  config,
  onConfigChange,
  onProjectUpdated,
  onError,
  onReady,
  applyProjectDefault = true,
  showConversationSettings = true,
}: ConfigPanelProps) {
  const [branches, setBranches] = useState<string[]>([])
  const [presets, setPresets] = useState<Preset[]>([])
  const [selectedPresetId, setSelectedPresetId] = useState('')
  const [action, setAction] = useState<MenuAction>(null)
  const [draftName, setDraftName] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [isBusy, setIsBusy] = useState(false)
  const configRef = useRef(config)
  configRef.current = config

  const selectedPreset = presets.find((preset) => preset.id === selectedPresetId) ?? null
  const isDefault = selectedPresetId !== '' && selectedPresetId === project.default_preset_id

  // Les branches existantes alimentent la complétion : une faute de frappe
  // créerait une branche jumelle au lieu de rejoindre la bonne.
  useEffect(() => {
    const controller = new AbortController()
    void getProjectGit(project.id, null, controller.signal)
      .then((snapshot) => { if (!controller.signal.aborted) setBranches(branchSuggestions(snapshot.branches)) })
      .catch(() => {})
    return () => controller.abort()
  }, [project.id])

  useEffect(() => {
    const abortController = new AbortController()
    setIsLoading(true)
    onReady?.(false)
    void listPresets(abortController.signal)
      .then((loaded) => {
        if (abortController.signal.aborted) return
        setPresets(loaded)
        const projectDefault = loaded.find((preset) => preset.id === project.default_preset_id)
        if (applyProjectDefault && projectDefault) {
          setSelectedPresetId(projectDefault.id)
          onConfigChange(configOf(projectDefault))
          return
        }
        const matchingPreset = loaded.find((preset) => sameConfig(configRef.current, configOf(preset)))
        setSelectedPresetId(matchingPreset?.id ?? '')
      })
      .catch((error: unknown) => {
        if (!abortController.signal.aborted) onError(errorMessage(error))
      })
      .finally(() => {
        if (!abortController.signal.aborted) {
          setIsLoading(false)
          onReady?.(true)
        }
      })
    return () => abortController.abort()
  }, [
    applyProjectDefault,
    onConfigChange,
    onError,
    onReady,
    project.default_preset_id,
    project.id,
  ])

  function selectPreset(preset: Preset) {
    setSelectedPresetId(preset.id)
    onConfigChange(configOf(preset))
  }

  function replace(updated: Preset) {
    setPresets((current) => current.map((preset) => preset.id === updated.id ? updated : preset))
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

  function applyToPreset() {
    if (!selectedPreset) return
    void run(async () => {
      const updated = await updatePreset(selectedPreset.id, {
        name: selectedPreset.name,
        provider: config.provider,
        model: config.model,
        effort: config.effort,
        speed: config.provider === 'codex' ? config.speed : null,
        orchestrator: config.orchestrator,
        subagent_preset_id: config.subagentPresetId,
        subagent_effort: config.subagentEffort,
        permission_mode: config.permissionMode,
        ...(!selectedPreset.built_in ? {
          review_provider: config.provider,
          review_model: config.model,
          review_effort: config.effort,
        } : {}),
      })
      replace(updated)
      if (isDefault) onProjectUpdated(await setProjectDefaultPreset(project.id, updated.id))
    })
  }

  function saveAs() {
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
        subagent_preset_id: config.subagentPresetId,
        subagent_effort: config.subagentEffort,
        permission_mode: config.permissionMode,
        review_provider: config.provider,
        review_model: config.model,
        review_effort: config.effort,
      })
      setPresets((current) => [...current, created])
      setSelectedPresetId(created.id)
      setDraftName('')
      setAction(null)
    })
  }

  function rename() {
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
        subagent_preset_id: selectedPreset.subagent_preset_id,
        subagent_effort: selectedPreset.subagent_effort,
        permission_mode: selectedPreset.permission_mode,
      }))
      setDraftName('')
      setAction(null)
    })
  }

  function restore() {
    if (!selectedPreset) return
    void run(async () => {
      const restored = await restorePreset(selectedPreset.id)
      replace(restored)
      onConfigChange(configOf(restored))
    })
  }

  function remove() {
    if (!selectedPreset || selectedPreset.built_in) return
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

  function toggleDefault() {
    void run(async () => {
      onProjectUpdated(await setProjectDefaultPreset(project.id, isDefault ? null : selectedPresetId || null))
    })
  }

  function openAction(next: Exclude<MenuAction, null>) {
    setAction(next)
    setDraftName(next === 'rename' ? selectedPreset?.name ?? '' : '')
  }

  return (
    <div className="config-panel" aria-label="Configuration de la conversation">
      <ModelConfigSelector
        config={config}
        presets={presets}
        selectedPresetId={selectedPresetId}
        quotas={quotas}
        isLoading={isLoading}
        isBusy={isBusy}
        isDefault={isDefault}
        showConversationSettings={showConversationSettings}
        onConfigChange={onConfigChange}
        onPresetSelect={selectPreset}
        onSaveAs={() => openAction('save-as')}
        onOverwrite={applyToPreset}
        onRevert={() => selectedPreset && onConfigChange(configOf(selectedPreset))}
        onRename={() => openAction('rename')}
        onDelete={remove}
        onRestore={restore}
        onToggleDefault={toggleDefault}
        onHelp={() => { window.location.hash = '#help/presets' }}
      />

      <label className="config-branch">
        <span>Branche</span>
        <input
          type="text"
          list="config-branch-options"
          value={config.branch ?? ''}
          placeholder="dépôt principal"
          disabled={isBusy}
          onChange={(event) => onConfigChange({ ...config, branch: event.target.value })}
        />
        <datalist id="config-branch-options">
          {branches.map((name) => <option key={name} value={name} />)}
        </datalist>
      </label>

      {action !== null ? (
        <div className="config-inline-form">
          <label htmlFor="config-preset-name">{action === 'rename' ? 'Nouveau nom' : 'Nom du preset'}</label>
          <input
            id="config-preset-name"
            autoFocus
            value={draftName}
            placeholder={action === 'rename' ? 'Vitesse' : 'Ma configuration'}
            onChange={(event) => setDraftName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setAction(null)
              if (event.key !== 'Enter') return
              event.preventDefault()
              if (action === 'rename') rename()
              else saveAs()
            }}
          />
          <button type="button" className="config-primary" disabled={!draftName.trim() || isBusy} onClick={action === 'rename' ? rename : saveAs}>
            {action === 'rename' ? 'Renommer' : 'Enregistrer'}
          </button>
          <button type="button" className="config-ghost" onClick={() => setAction(null)}>Annuler</button>
        </div>
      ) : null}
    </div>
  )
}
