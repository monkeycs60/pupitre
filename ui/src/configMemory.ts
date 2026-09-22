import type { ConversationConfig } from './ConfigPanel'
import { PROVIDER_EFFORTS, PROVIDER_MODELS, requiresLaunchConfirmation } from './modelOptions'
import type { Provider } from './types'

/**
 * La dernière configuration lancée sur un projet est la plus probable pour la
 * suivante. Elle est gardée par projet : on ne travaille pas de la même façon
 * sur deux dépôts. Un modèle soumis à confirmation n'est jamais mémorisé : la
 * mémoire garde le dernier choix ordinaire.
 */
const KEY_PREFIX = 'pupitre:launch-config:v2:'

/** Un modèle retiré du catalogue ne doit pas ressusciter par la mémoire. */
function isKnown(provider: Provider, model: string, effort: string): boolean {
  const models = PROVIDER_MODELS[provider] as readonly string[] | undefined
  const efforts = PROVIDER_EFFORTS[provider] as readonly string[] | undefined
  return models !== undefined && models.includes(model)
    && efforts !== undefined && efforts.includes(effort)
}

function storage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function readLaunchConfig(projectId: string): ConversationConfig | null {
  const store = storage()
  if (store === null) return null
  let parsed: unknown
  try {
    const raw = store.getItem(`${KEY_PREFIX}${projectId}`)
    if (raw === null) return null
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const memory = parsed as Record<string, unknown>
  const provider = memory.provider
  const model = memory.model
  const effort = memory.effort
  if (typeof provider !== 'string' || typeof model !== 'string' || typeof effort !== 'string') return null
  if (!isKnown(provider as Provider, model, effort) || requiresLaunchConfirmation(model)) return null
  return {
    presetId: null,
    provider: provider as Provider,
    model,
    effort,
    speed: memory.speed === 'fast' ? 'fast' : 'standard',
    permissionMode: typeof memory.permissionMode === 'string'
      ? memory.permissionMode as ConversationConfig['permissionMode']
      : null,
  }
}

/** Mémorise le moteur du tour ; branche et ticket appartiennent à la tâche. */
export function writeLaunchConfig(projectId: string, config: ConversationConfig): void {
  const store = storage()
  if (store === null || requiresLaunchConfirmation(config.model)) return
  try {
    store.setItem(`${KEY_PREFIX}${projectId}`, JSON.stringify({
      provider: config.provider,
      model: config.model,
      effort: config.effort,
      speed: config.speed,
      permissionMode: config.permissionMode,
    }))
  } catch {
    // Le quota de stockage ou un mode privé ne doit pas casser l'envoi.
  }
}
