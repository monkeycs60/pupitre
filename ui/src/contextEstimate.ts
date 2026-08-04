import { estimatedReingestionTokens } from './modelSwitch'
import type { AppEvent, Provider } from './types'

const MODEL_CONTEXT_WINDOWS: Partial<Record<Provider, Record<string, number>>> = {
  // Valeurs de référence affichées comme estimations : aucune décision
  // automatique n'est prise à partir de cette jauge.
  claude: {
    'fable-5': 200_000,
    opus: 200_000,
    sonnet: 200_000,
    haiku: 200_000,
  },
  codex: {
    'gpt-5.6-sol': 400_000,
    'gpt-5.6-luna': 400_000,
  },
}

const FALLBACK_CONTEXT_WINDOWS: Record<Provider, number> = {
  claude: 200_000,
  codex: 400_000,
}

export interface ContextEstimate {
  usedTokens: number
  windowTokens: number
  percent: number
  nearSaturation: boolean
}

export function contextWindowTokens(provider: Provider, model: string): number {
  return MODEL_CONTEXT_WINDOWS[provider]?.[model] ?? FALLBACK_CONTEXT_WINDOWS[provider]
}

export function contextEstimate(
  events: AppEvent[],
  provider: Provider,
  model: string,
): ContextEstimate {
  const usedTokens = estimatedReingestionTokens(events)
  const windowTokens = contextWindowTokens(provider, model)
  const percent = Math.min(100, Math.round((usedTokens / windowTokens) * 100))
  return {
    usedTokens,
    windowTokens,
    percent,
    nearSaturation: percent >= 80,
  }
}
