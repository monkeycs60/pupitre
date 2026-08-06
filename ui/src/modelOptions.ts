import type { Provider } from './types'

export const PROVIDER_MODELS = {
  claude: ['fable-5', 'opus', 'sonnet', 'haiku'],
  codex: ['gpt-5.6-sol', 'gpt-5.6-luna'],
} as const satisfies Record<Provider, readonly string[]>

export const PROVIDER_EFFORTS = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh'],
} as const satisfies Record<Provider, readonly string[]>

/**
 * Ce que chaque modèle apporte, en trois mots. Le quota, lui, est publié par
 * fenêtre et par provider, jamais par modèle : le répéter sur chaque carte
 * n'apprendrait rien et ferait quatre fois le même bruit.
 */
export const MODEL_HINTS: Record<string, string> = {
  'fable-5': 'le plus capable',
  opus: 'raisonnement profond',
  sonnet: 'équilibré',
  haiku: 'rapide et économe',
  'gpt-5.6-sol': 'le plus capable',
  'gpt-5.6-luna': 'rapide et économe',
}

/**
 * Ce que l'orchestrateur peut faire quand la délégation est autorisée.
 *
 * Il n'y a pas de liste figée de sub-agents : le modèle principal choisit
 * lui-même provider et modèle pour chaque sous-tâche, parmi `PROVIDER_MODELS`
 * des DEUX abonnements. Ce qui est connu d'avance, c'est le routage qu'on lui
 * recommande et la limite de concurrence — c'est donc ça qu'on affiche, plutôt
 * qu'une liste de modèles qui laisserait croire à un choix déjà fait.
 *
 * Source de vérité : `RECO_DOC` dans `sidecar/src/conductor-mcp.ts` et
 * `MAX_CONCURRENT_SUBTASKS` dans `sidecar/src/subtasks.ts`. Un test de
 * cohérence (`sidecar/tests/ui-delegation.test.ts`) empêche la dérive.
 */
export const DELEGATION_ROUTING = {
  provider: 'codex',
  model: 'gpt-5.6-luna',
  effort: 'low ou medium',
  speed: 'rapide',
} as const

/** Sous-tâches simultanées par conversation parente. */
export const MAX_CONCURRENT_SUBTASKS = 4

// Les jugements Gardien n'utilisent jamais les modèles économiques.
export const REVIEW_MODELS = {
  claude: ['fable-5', 'opus', 'sonnet'],
  codex: ['gpt-5.6-sol'],
} as const satisfies Record<Provider, readonly string[]>
