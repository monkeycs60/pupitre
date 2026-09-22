import { useEffect, useRef, useState } from 'react'
import { getProjectGit } from './api'
import { BranchAutocomplete } from './BranchAutocomplete'
import { readLaunchConfig, writeLaunchConfig } from './configMemory'
import { ModelConfigSelector } from './ModelConfigSelector'
import { requiresLaunchConfirmation } from './modelOptions'
import { branchSuggestions } from './worktrees'
import type {
  ConversationSpeed,
  PresetPermissionMode,
  Project,
  Provider,
  QuotaSnapshot,
  GitBranchOption,
  GitWorkspaceSelection,
} from './types'

/** Les décisions de lancement d'une conversation, sans son premier message. */
export interface ConversationConfig {
  presetId?: string | null
  provider: Provider
  model: string
  effort: string
  speed: ConversationSpeed
  permissionMode: PresetPermissionMode | null
  /** Branche sur laquelle isoler la conversation ; vide = dépôt principal. */
  branch?: string | null
  repositoryPath?: string | null
  workspaces?: GitWorkspaceSelection[]
  ticketKey?: string | null
}

interface ConfigPanelProps {
  project: Project
  quotas: QuotaSnapshot
  config: ConversationConfig
  onConfigChange: (config: ConversationConfig) => void
  onReady?: (ready: boolean) => void
  /** La modale de bascule conserve sa configuration au lieu du défaut projet. */
  applyProjectDefault?: boolean
  /** Les réglages de conversation exigent des routes dédiées après création. */
  showConversationSettings?: boolean
  /**
   * Mémorise la configuration sous cette clé et la repropose à l'ouverture
   * suivante. Le composer y met l'identifiant du projet ; la bascule de modèle
   * et les TODO s'en passent, leur choix vaut pour leur seul objet.
   */
  memoryKey?: string | null
  placement?: 'top' | 'bottom'
  /** Les tâches restent ancrées au dépôt racine ; les conversations savent choisir un dépôt applicatif. */
  includeNestedRepositories?: boolean
}

function keepBranch(next: ConversationConfig, current: ConversationConfig): ConversationConfig {
  return {
    ...next,
    branch: current.branch ?? null,
    repositoryPath: current.repositoryPath ?? null,
    workspaces: current.workspaces ?? [],
    ticketKey: current.ticketKey ?? null,
  }
}

/**
 * Réglette de lancement : provider, modèle, effort et branche. La
 * configuration d'ouverture vient de la mémoire du projet, à défaut du preset
 * par défaut que les TODO continuent d'utiliser.
 */
export function ConfigPanel({
  project,
  quotas,
  config,
  onConfigChange,
  onReady,
  applyProjectDefault = true,
  showConversationSettings = true,
  memoryKey = null,
  placement = 'top',
  includeNestedRepositories = true,
}: ConfigPanelProps) {
  const [branches, setBranches] = useState<GitBranchOption[]>([])
  const [currentBranch, setCurrentBranch] = useState<string | null>(null)
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
        const options = includeNestedRepositories
          ? snapshot.branchOptions ?? []
          : snapshot.branches.map((branch) => ({
              ...branch,
              repositoryPath: project.path,
              repositoryLabel: project.name,
            }))
        setBranches(branchSuggestions(options))
        setCurrentBranch(snapshot.currentBranch)
      })
      .catch(() => {})
    return () => controller.abort()
  }, [includeNestedRepositories, project.id, project.name, project.path])

  useEffect(() => {
    if (applyProjectDefault) {
      const remembered = memoryKey === null ? null : readLaunchConfig(memoryKey)
      const projectDefault = project.default_launch_config ?? null
      if (remembered !== null) {
        onConfigChange(keepBranch(remembered, configRef.current))
      } else if (projectDefault !== null && !(memoryKey !== null && requiresLaunchConfirmation(projectDefault.model))) {
        onConfigChange(keepBranch({ presetId: null, ...projectDefault, permissionMode: null }, configRef.current))
      }
    }
    setIsLoading(false)
    onReady?.(true)
  }, [applyProjectDefault, memoryKey, onConfigChange, onReady, project.default_launch_config, project.id])

  function changeConfig(next: ConversationConfig) {
    if (memoryKey !== null) writeLaunchConfig(memoryKey, next)
    onConfigChange(next)
  }

  function toggleWorkspace(option: GitBranchOption) {
    const current = config.workspaces ?? (config.branch && config.repositoryPath
      ? [{ branch: config.branch, repositoryPath: config.repositoryPath, repositoryLabel: option.repositoryLabel }]
      : [])
    const key = `${option.repositoryPath}\0${option.name}`
    const exists = current.some((item) => `${item.repositoryPath}\0${item.branch}` === key)
    const workspaces = exists
      ? current.filter((item) => `${item.repositoryPath}\0${item.branch}` !== key)
      : [...current, { branch: option.name, repositoryPath: option.repositoryPath, repositoryLabel: option.repositoryLabel }]
    const primary = workspaces[0] ?? null
    onConfigChange({
      ...config,
      branch: primary?.branch ?? null,
      repositoryPath: primary?.repositoryPath ?? null,
      workspaces,
    })
  }

  return (
    <div className="config-panel" aria-label="Configuration de la conversation">
      <ModelConfigSelector
        config={config}
        projectPermissionMode={project.permission_mode}
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
          selected={config.workspaces ?? []}
          currentBranch={currentBranch}
          disabled={isLoading}
          placement={placement}
          onChange={(branch, repositoryPath) => onConfigChange({ ...config, branch, repositoryPath, workspaces: [] })}
          onToggle={toggleWorkspace}
        />
        {config.ticketKey ? <small className="config-ticket">Ticket {config.ticketKey}</small> : null}
      </div>
    </div>
  )
}
