import { useEffect, useRef, useState } from 'react'
import { getProjectGit, listPresets } from './api'
import { BranchAutocomplete } from './BranchAutocomplete'
import { readLaunchConfig, writeLaunchConfig } from './configMemory'
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
  ticketKey?: string | null
}

interface ConfigPanelProps {
  project: Project
  quotas: QuotaSnapshot
  config: ConversationConfig
  onConfigChange: (config: ConversationConfig) => void
  onError: (message: string) => void
  onReady?: (ready: boolean) => void
  /** La modale de bascule conserve sa configuration au lieu du défaut projet. */
  applyProjectDefault?: boolean
  /**
   * Preset appliqué à l'ouverture à la place de `project.default_preset_id` :
   * l'éditeur de TODO peut ainsi viser son propre défaut.
   */
  defaultPresetId?: string | null
  /** Les réglages de conversation exigent des routes dédiées après création. */
  showConversationSettings?: boolean
  /**
   * Mémorise la configuration sous cette clé et la repropose à l'ouverture
   * suivante. Le composer y met l'identifiant du projet ; la bascule de modèle
   * et les TODO s'en passent, leur choix vaut pour leur seul objet.
   */
  memoryKey?: string | null
  placement?: 'top' | 'bottom'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Une erreur est survenue.'
}

export function configOf(preset: Preset): ConversationConfig {
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

function keepBranch(next: ConversationConfig, current: ConversationConfig): ConversationConfig {
  return {
    ...next,
    branch: current.branch ?? null,
    ticketKey: current.ticketKey ?? null,
  }
}

/**
 * Réglette de lancement : provider, modèle, effort et branche. La
 * configuration d'ouverture vient de la mémoire du projet, à défaut du preset
 * par défaut que Gardien et les TODO continuent d'utiliser.
 */
export function ConfigPanel({
  project,
  quotas,
  config,
  onConfigChange,
  onError,
  onReady,
  applyProjectDefault = true,
  defaultPresetId,
  showConversationSettings = true,
  memoryKey = null,
  placement = 'top',
}: ConfigPanelProps) {
  const [branches, setBranches] = useState<string[]>([])
  const [currentBranch, setCurrentBranch] = useState<string | null>(null)
  const [presets, setPresets] = useState<Preset[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const configRef = useRef(config)
  configRef.current = config

  // Les branches existantes alimentent la complétion : une faute de frappe
  // créerait une branche jumelle au lieu de rejoindre la bonne.
  useEffect(() => {
    const controller = new AbortController()
    void getProjectGit(project.id, null, controller.signal)
      .then((snapshot) => {
        if (controller.signal.aborted) return
        setBranches(branchSuggestions(snapshot.branches))
        setCurrentBranch(snapshot.currentBranch)
      })
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
        if (!applyProjectDefault) return
        const remembered = memoryKey === null ? null : readLaunchConfig(memoryKey)
        if (remembered !== null) {
          onConfigChange(keepBranch(remembered, configRef.current))
          return
        }
        const projectDefault = loaded.find((preset) => preset.id === (defaultPresetId ?? project.default_preset_id))
          ?? loaded.find((preset) => preset.id === 'builtin-speed')
          ?? loaded[0]
        if (projectDefault) onConfigChange(keepBranch(configOf(projectDefault), configRef.current))
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
    defaultPresetId,
    memoryKey,
    onConfigChange,
    onError,
    onReady,
    project.default_preset_id,
    project.id,
  ])

  function changeConfig(next: ConversationConfig) {
    if (memoryKey !== null) writeLaunchConfig(memoryKey, next)
    onConfigChange(next)
  }

  return (
    <div className="config-panel" aria-label="Configuration de la conversation">
      <ModelConfigSelector
        config={config}
        presets={presets}
        quotas={quotas}
        isLoading={isLoading}
        showConversationSettings={showConversationSettings}
        onConfigChange={changeConfig}
        placement={placement}
      />

      <div className="config-branch">
        <BranchAutocomplete
          value={config.branch ?? ''}
          branches={branches}
          currentBranch={currentBranch}
          disabled={isLoading}
          placement={placement}
          onChange={(branch) => onConfigChange({ ...config, branch })}
        />
        {config.ticketKey ? <small className="config-ticket">Ticket {config.ticketKey}</small> : null}
      </div>
    </div>
  )
}
