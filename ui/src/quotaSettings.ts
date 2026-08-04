import type { Settings } from './api'
import {
  DEFAULT_QUOTA_THRESHOLDS,
  type QuotaThresholds,
} from './quotaSignals'

export const LEGACY_THRESHOLDS_KEY = 'pupitre.quota-thresholds'

interface ThresholdStorage {
  getItem(key: string): string | null
  removeItem(key: string): void
}

function validThresholds(value: unknown): QuotaThresholds | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const candidate = value as Partial<QuotaThresholds>
  if (typeof candidate.lastHour !== 'boolean') return null
  if (
    candidate.usedPercent !== null
    && (typeof candidate.usedPercent !== 'number'
      || !Number.isFinite(candidate.usedPercent)
      || candidate.usedPercent < 0
      || candidate.usedPercent > 100)
  ) return null
  return {
    lastHour: candidate.lastHour,
    usedPercent: candidate.usedPercent,
  }
}

function readLegacy(storage: ThresholdStorage): QuotaThresholds | null {
  try {
    const raw = storage.getItem(LEGACY_THRESHOLDS_KEY)
    return raw === null ? null : validThresholds(JSON.parse(raw))
  } catch {
    return null
  }
}

/**
 * Source de vérité : settings sidecar. Si elle est vide, importe une seule fois
 * l'ancienne valeur locale (ou les défauts), puis retire la clé historique.
 */
export async function loadQuotaThresholds(
  getSettings: () => Promise<Settings>,
  saveSettings: (settings: Settings) => Promise<Settings>,
  storage: ThresholdStorage,
): Promise<QuotaThresholds> {
  const settings = await getSettings()
  const persisted = validThresholds(settings.quotaThresholds)
  if (persisted !== null) return persisted

  const thresholds = readLegacy(storage) ?? DEFAULT_QUOTA_THRESHOLDS
  await saveSettings({ quotaThresholds: thresholds })
  try {
    storage.removeItem(LEGACY_THRESHOLDS_KEY)
  } catch {
    // Le réglage est déjà durable côté sidecar ; le nettoyage est secondaire.
  }
  return thresholds
}
