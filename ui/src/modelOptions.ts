import type { Provider } from './types'

export const PROVIDER_MODELS = {
  claude: ['fable-5', 'opus', 'sonnet', 'haiku'],
  codex: ['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-terra'],
  grok: ['grok-4.6', 'grok-4.5'],
} as const satisfies Record<Provider, readonly string[]>

export const PROVIDER_EFFORTS = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh'],
  grok: ['low', 'medium', 'high', 'xhigh'],
} as const satisfies Record<Provider, readonly string[]>

/**
 * Nom lisible d'un modèle. Les identifiants passés aux CLI sont des alias
 * (`opus`, `sonnet`) : ils ne disent pas quelle génération tourne réellement,
 * d'où cette table d'affichage. À tenir à jour à chaque sortie de modèle.
 */
export const MODEL_LABELS: Record<string, string> = {
  'fable-5': 'Fable 5',
  opus: 'Opus 5',
  sonnet: 'Sonnet 5',
  haiku: 'Haiku 4.5',
  'gpt-5.6-sol': 'GPT-5.6 Sol',
  'gpt-5.6-luna': 'GPT-5.6 Luna',
  'gpt-5.6-terra': 'GPT-5.6 Terra',
  'grok-4.6': 'Grok 4.6',
  'grok-4.5': 'Grok 4.5',
}

/** Un modèle inconnu s'affiche tel quel plutôt que de disparaître. */
export function modelLabel(model: string): string {
  return MODEL_LABELS[model] ?? model
}

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
  'gpt-5.6-terra': 'polyvalent',
  'grok-4.6': 'le plus capable',
  'grok-4.5': 'génération précédente',
}

/** Un échange représentatif, utilisé uniquement pour comparer les tarifs API. */
export const MODEL_COST_REFERENCE = {
  inputTokens: 40_000,
  outputTokens: 3_000,
} as const

/** Nombre de crans visibles dans les jauges du sélecteur de modèle. */
export const MODEL_COST_TICKS = 20

export type ModelCostTone = 'ok' | 'warn' | 'danger'

export interface ModelPricing {
  provider: Provider
  model: string
  input: number
  output: number
}

/**
 * Tarifs indicatifs en dollars par million de tokens, relevés le 22 août 2026.
 * Ils ne représentent jamais une facture d'abonnement : le sélecteur les
 * emploie seulement pour rendre le compromis coût/capacité lisible.
 */
export const MODEL_PRICING: readonly ModelPricing[] = [
  { provider: 'codex', model: 'gpt-5.6-sol', input: 5, output: 30 },
  { provider: 'codex', model: 'gpt-5.6-luna', input: 0.2, output: 1.2 },
  { provider: 'codex', model: 'gpt-5.6-terra', input: 2, output: 12 },
  { provider: 'claude', model: 'fable-5', input: 10, output: 50 },
  { provider: 'claude', model: 'opus', input: 5, output: 25 },
  { provider: 'claude', model: 'sonnet', input: 2, output: 10 },
  { provider: 'claude', model: 'haiku', input: 1, output: 5 },
  { provider: 'grok', model: 'grok-4.6', input: 2, output: 6 },
  { provider: 'grok', model: 'grok-4.5', input: 2, output: 6 },
]

export function modelPricing(model: string): ModelPricing | null {
  return MODEL_PRICING.find((pricing) => pricing.model === model) ?? null
}

/** Coût estimé d'un échange de référence, en dollars. */
export function modelExchangeCost(model: string): number | null {
  const pricing = modelPricing(model)
  if (pricing === null) return null
  return (
    MODEL_COST_REFERENCE.inputTokens * pricing.input
    + MODEL_COST_REFERENCE.outputTokens * pricing.output
  ) / 1_000_000
}

function pricedCosts(): number[] {
  return MODEL_PRICING.map((pricing) => modelExchangeCost(pricing.model) ?? 0)
}

/** Jauge linéaire, de un à vingt crans, rapportée au modèle le plus cher. */
export function modelCostTicks(model: string): number {
  const cost = modelExchangeCost(model)
  const max = Math.max(...pricedCosts())
  if (cost === null || max === 0) return 1
  return Math.max(1, Math.min(MODEL_COST_TICKS, Math.round(cost / max * MODEL_COST_TICKS)))
}

/** Couleur liée au coût absolu, et non au modèle actuellement sélectionné. */
export function modelCostTone(model: string): ModelCostTone {
  const cost = modelExchangeCost(model)
  const min = Math.min(...pricedCosts())
  if (cost === null || min === 0) return 'warn'
  const multiple = Math.round(cost / min)
  if (multiple < 5) return 'ok'
  if (multiple < 15) return 'warn'
  return 'danger'
}

/** Compare un candidat à la sélection, sans masquer les modèles moins chers. */
export function relativeCostLabel(candidate: string, selected: string): string {
  const candidateCost = modelExchangeCost(candidate)
  const selectedCost = modelExchangeCost(selected)
  if (candidateCost === null || selectedCost === null || selectedCost === 0) return '—'
  const ratio = candidateCost / selectedCost
  if (ratio >= 1.5) return `×${Math.round(ratio)}`
  if (ratio <= 0.67) return `÷${Math.round(1 / ratio)}`
  return '×1'
}

function frenchAmount(value: number): string {
  return (Number.isInteger(value) ? String(value) : value.toFixed(2)).replace('.', ',')
}

export function formatModelPrice(model: string): string {
  const pricing = modelPricing(model)
  return pricing === null ? '—' : `${frenchAmount(pricing.input)} / ${frenchAmount(pricing.output)} $`
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

/** Gardien propose exactement le même catalogue que le chat. */
export const REVIEW_MODELS = PROVIDER_MODELS
