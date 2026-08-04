import type { Provider } from './types'

export const PROVIDER_MODELS = {
  claude: ['fable-5', 'opus', 'sonnet', 'haiku'],
  codex: ['gpt-5.6-sol', 'gpt-5.6-luna'],
} as const satisfies Record<Provider, readonly string[]>

export const PROVIDER_EFFORTS = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh'],
} as const satisfies Record<Provider, readonly string[]>

// Les jugements Gardien n'utilisent jamais les modèles économiques.
export const REVIEW_MODELS = {
  claude: ['fable-5', 'opus', 'sonnet'],
  codex: ['gpt-5.6-sol'],
} as const satisfies Record<Provider, readonly string[]>
