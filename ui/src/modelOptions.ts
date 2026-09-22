import type { ConversationSpeed, PresetPermissionMode, Provider } from './types'

/** Ordre des providers dans toutes les listes et sélecteurs. */
export const PROVIDERS = ['codex', 'claude', 'grok', 'reasonix'] as const satisfies readonly Provider[]

/**
 * Nom affiché d'un provider. Il nomme l'abonnement consommé, pas le binaire
 * lancé : `reasonix` consomme l'abonnement OpenCode Go (base_url
 * `https://opencode.ai/zen/go`, clé `OPENCODE_API_KEY`), d'où « OpenCode Go
 * (Reasonix) » — l'abonnement d'abord, le CLI entre parenthèses pour qui lit
 * les journaux.
 */
export const PROVIDER_LABELS: Record<Provider, string> = {
  codex: 'Codex',
  claude: 'Claude',
  grok: 'Grok',
  reasonix: 'OpenCode Go (Reasonix)',
}

/**
 * Variante pour les colonnes à largeur bornée : la barre de quotas compacte
 * n'accorde que 44 px au nom du provider, qui y serait tronqué.
 */
export const PROVIDER_SHORT_LABELS: Record<Provider, string> = {
  ...PROVIDER_LABELS,
  reasonix: 'OpenCode Go',
}

export const PROVIDER_MODELS = {
  claude: ['fable-5.1', 'opus-5.5', 'sonnet', 'haiku'],
  codex: ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'],
  grok: ['grok-4.6', 'grok-4.5'],
  reasonix: ['go41'],
} as const satisfies Record<Provider, readonly string[]>

export const PROVIDER_EFFORTS = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh'],
  grok: ['low', 'medium', 'high', 'xhigh'],
  reasonix: ['disabled', 'low', 'high', 'max'],
} as const satisfies Record<Provider, readonly string[]>

/**
 * Modèle et effort proposés à l'arrivée sur un provider. Le premier modèle du
 * catalogue n'est pas retenu : il est le plus capable, donc le plus cher et
 * souvent soumis à confirmation. On vise un réglage sûr à lancer, quitte à
 * monter d'un cran à la main.
 */
export const PROVIDER_DEFAULTS = {
  codex: { model: 'gpt-6-sol', effort: 'high' },
  claude: { model: 'opus-5.5', effort: 'medium' },
  grok: { model: 'grok-4.6', effort: 'high' },
  reasonix: { model: 'go41', effort: 'high' },
} as const satisfies Record<Provider, { model: string; effort: string }>

/**
 * Réglage d'ouverture de la grille manuelle d'un workflow : le profil économe de
 * Codex — le modèle le moins cher, effort maximal, en vitesse rapide. Un workflow
 * est fait pour tourner souvent, d'où ce choix assumé plutôt que
 * `PROVIDER_DEFAULTS.codex`, plus cher. C'est le profil du preset « Vitesse ».
 */
export const WORKFLOW_DEFAULTS = {
  provider: 'codex',
  model: 'gpt-6-luna',
  effort: 'xhigh',
  speed: 'fast',
} as const satisfies { provider: Provider; model: string; effort: string; speed: ConversationSpeed }

/**
 * Nom lisible d'un modèle. Les identifiants passés aux CLI sont des alias
 * (`opus`, `sonnet`) : ils ne disent pas quelle génération tourne réellement,
 * d'où cette table d'affichage. À tenir à jour à chaque sortie de modèle.
 */
export const MODEL_LABELS: Record<string, string> = {
  'fable-5.1': 'Fable 5.1',
  'fable-5': 'Fable 5',
  'opus-5.5': 'Opus 5.5',
  opus: 'Opus 5',
  sonnet: 'Sonnet 5',
  haiku: 'Haiku 4.5',
  'gpt-6-astra': 'GPT-6 Astra',
  'gpt-6-sol': 'GPT-6 Sol',
  'gpt-6-luna': 'GPT-6 Luna',
  'gpt-5.6-sol': 'GPT-5.6 Sol',
  'gpt-5.6-luna': 'GPT-5.6 Luna',
  'gpt-5.6-terra': 'GPT-5.6 Terra',
  'grok-4.6': 'Grok 4.6',
  'grok-4.5': 'Grok 4.5',
  go41: 'GO 4.1',
}

/** Modèles dont un lancement par inadvertance entame fortement le quota. */
const CONFIRMED_MODELS: ReadonlySet<string> = new Set(['fable-5.1', 'fable-5', 'gpt-6-astra'])

export function requiresLaunchConfirmation(model: string): boolean {
  return CONFIRMED_MODELS.has(model)
}

/** Un modèle inconnu s'affiche tel quel plutôt que de disparaître. */
export function modelLabel(model: string): string {
  return MODEL_LABELS[model] ?? model
}

/**
 * Ce que coûte un cran d'effort, en trois mots : l'échelle est ordinale mais
 * ses paliers n'ont pas de sens évident hors du contexte de chaque provider.
 */
export const EFFORT_HINTS: Record<string, string> = {
  low: 'réponse directe',
  medium: 'réflexion courte',
  high: 'réflexion approfondie',
  xhigh: 'analyse longue',
  max: 'sans plafond de réflexion',
}

/**
 * Ce que chaque modèle apporte, en trois mots. Le quota, lui, est publié par
 * fenêtre et par provider, jamais par modèle : le répéter sur chaque carte
 * n'apprendrait rien et ferait quatre fois le même bruit.
 */
export const MODEL_HINTS: Record<string, string> = {
  'fable-5.1': 'le plus capable',
  'fable-5': 'génération précédente',
  'opus-5.5': 'raisonnement profond',
  opus: 'génération précédente',
  sonnet: 'équilibré',
  haiku: 'rapide et économe',
  'gpt-6-astra': 'le plus capable',
  'gpt-6-sol': 'raisonnement profond',
  'gpt-6-luna': 'rapide et économe',
  'gpt-5.6-sol': 'génération précédente',
  'gpt-5.6-luna': 'génération précédente',
  'gpt-5.6-terra': 'polyvalent',
  'grok-4.6': 'le plus capable',
  'grok-4.5': 'génération précédente',
  go41: 'DeepSeek V4.1 Flash',
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
 * Tarifs indicatifs en dollars par million de tokens, relevés le 6 septembre 2026 (Opus 5.5 et GPT-6 Sol/Luna : 22 septembre).
 * Ils ne représentent jamais une facture d'abonnement : le sélecteur les
 * emploie seulement pour rendre le compromis coût/capacité lisible.
 */
export const MODEL_PRICING: readonly ModelPricing[] = [
  { provider: 'codex', model: 'gpt-6-astra', input: 10, output: 50 },
  { provider: 'codex', model: 'gpt-6-sol', input: 2, output: 10 },
  { provider: 'codex', model: 'gpt-6-luna', input: 0.1, output: 0.5 },
  { provider: 'codex', model: 'gpt-5.6-sol', input: 5, output: 30 },
  { provider: 'codex', model: 'gpt-5.6-luna', input: 0.2, output: 1.2 },
  { provider: 'codex', model: 'gpt-5.6-terra', input: 2, output: 12 },
  { provider: 'claude', model: 'fable-5.1', input: 10, output: 50 },
  { provider: 'claude', model: 'fable-5', input: 10, output: 50 },
  { provider: 'claude', model: 'opus-5.5', input: 4, output: 20 },
  { provider: 'claude', model: 'opus', input: 5, output: 25 },
  { provider: 'claude', model: 'sonnet', input: 2, output: 10 },
  { provider: 'claude', model: 'haiku', input: 1, output: 5 },
  { provider: 'grok', model: 'grok-4.6', input: 2, output: 6 },
  { provider: 'grok', model: 'grok-4.5', input: 2, output: 6 },
  { provider: 'reasonix', model: 'go41', input: 0.22, output: 0.88 },
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
 * Échelle d'autonomie, du plus borné au plus ouvert. Le rang alimente la jauge
 * du menu : les quatre modes forment une progression, pas une liste de pairs.
 *
 * Les tours partent en headless : aucun CLI ne peut poser une question de
 * permission à l'écran. Un mode qui en demanderait une la verrait refusée, d'où
 * l'absence du mode natif des providers dans l'échelle.
 */
export const AUTONOMY_LEVELS = [
  {
    mode: 'plan',
    label: 'Plan / lecture seule',
    hint: 'Lit et propose. N’écrit rien.',
    tone: 'ok',
  },
  {
    mode: 'acceptEdits',
    label: 'Éditions acceptées',
    hint: 'Écrit dans les fichiers. Les commandes restent refusées.',
    tone: 'accent',
  },
  {
    mode: 'dontAsk',
    label: 'Autonome',
    hint: 'Édite et exécute sans demander, dans le périmètre du projet.',
    tone: 'warn',
  },
  {
    mode: 'bypassPermissions',
    label: 'YOLO · sans permissions',
    hint: 'Plus aucun garde-fou, périmètre compris.',
    tone: 'danger',
  },
] as const satisfies ReadonlyArray<{
  mode: PresetPermissionMode
  label: string
  hint: string
  tone: 'ok' | 'accent' | 'warn' | 'danger'
}>
