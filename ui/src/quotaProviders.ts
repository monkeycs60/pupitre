import type { Provider } from './types'

export const QUOTA_PROVIDERS = ['claude', 'codex', 'grok', 'reasonix'] as const satisfies readonly Provider[]

/** Diffusé par les réglages pour que la barre latérale suive sans rechargement. */
export const QUOTA_PROVIDERS_EVENT = 'pupitre:quota-providers'

/** Réglage absent ou illisible : tous les quotas restent affichés. */
export function visibleQuotaProviders(value: unknown): Provider[] {
  if (!Array.isArray(value)) return [...QUOTA_PROVIDERS]
  return QUOTA_PROVIDERS.filter((provider) => value.includes(provider))
}
