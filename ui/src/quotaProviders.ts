import type { Provider } from './types'

export const QUOTA_PROVIDERS = ['claude', 'codex', 'grok', 'reasonix'] as const satisfies readonly Provider[]

/** Diffusé par les réglages pour que la barre latérale suive sans rechargement. */
export const QUOTA_PROVIDERS_EVENT = 'pupitre:quota-providers'

function knownProviders(value: unknown): Provider[] {
  if (!Array.isArray(value)) return []
  return value.filter((provider): provider is Provider => (QUOTA_PROVIDERS as readonly unknown[]).includes(provider))
}

/** Réglage absent ou illisible : tous les quotas restent affichés. */
export function visibleQuotaProviders(value: unknown): Provider[] {
  if (!Array.isArray(value)) return [...QUOTA_PROVIDERS]
  const known = knownProviders(value)
  return QUOTA_PROVIDERS.filter((provider) => known.includes(provider))
}

/** Tous les providers, dans l'ordre choisi puis l'ordre par défaut pour ceux qui manquent. */
export function quotaProviderOrder(value: unknown): Provider[] {
  return [...new Set([...knownProviders(value), ...QUOTA_PROVIDERS])]
}

/** Jauges de la barre latérale : les providers visibles, dans l'ordre choisi. */
export function displayedQuotaProviders(settings: { quotaVisibleProviders?: unknown; quotaProviderOrder?: unknown }): Provider[] {
  const visible = visibleQuotaProviders(settings.quotaVisibleProviders)
  return quotaProviderOrder(settings.quotaProviderOrder).filter((provider) => visible.includes(provider))
}
