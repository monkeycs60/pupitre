import type { Provider, QuotaState, QuotaWindow } from './types'

// Logique pure des signaux de quota : formatage, pulse « use it or lose it » et
// franchissement de seuils de notification. Aucune dépendance DOM ni React —
// testée depuis sidecar/tests/ui-quota-signals.test.ts (comme mergeEvents).

/** Modèles « chers » par provider : ceux que le pulse invite à consommer. */
export const EXPENSIVE_MODELS = {
  claude: ['fable-5', 'opus'],
  codex: ['gpt-5.6-sol'],
} as const satisfies Record<Provider, readonly string[]>

/** Pulse : beaucoup de quota restant ET fenêtre qui expire bientôt. */
export const PULSE_MAX_USED_PERCENT = 50
export const PULSE_WITHIN_MS = 60 * 60 * 1000

export interface QuotaThresholds {
  /** Notifier à l'entrée dans la dernière heure d'une fenêtre. */
  lastHour: boolean
  /** Notifier au franchissement de ce pourcentage d'usage (null = jamais). */
  usedPercent: number | null
}

export const DEFAULT_QUOTA_THRESHOLDS: QuotaThresholds = {
  lastHour: true,
  usedPercent: 80,
}

export interface QuotaAlert {
  /**
   * Clé stable d'un franchissement : elle inclut le `resetsAt` de la fenêtre,
   * donc chaque nouvelle fenêtre re-notifie mais une même fenêtre une seule fois.
   */
  key: string
  title: string
  body: string
}

const HOUR_MS = 60 * 60 * 1000
const WEEKDAYS = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.']

/** Libellés lisibles des fenêtres, sinon la durée, sinon le label brut. */
export function windowTitle(window: QuotaWindow): string {
  switch (window.label) {
    case 'five_hour':
      return '5 h'
    case 'seven_day':
    case 'weekly':
      return 'hebdo'
    case 'opus_weekly':
    case 'seven_day_opus':
      return 'hebdo opus'
    case 'primary':
      return '5 h'
    case 'secondary':
      return 'hebdo'
    default:
      break
  }
  if (window.windowDurationMins === null) return window.label
  return window.windowDurationMins >= 1440
    ? `${Math.round(window.windowDurationMins / 1440)} j`
    : `${Math.round(window.windowDurationMins / 60)} h`
}

/** Millisecondes avant reset (négatif si dépassé), null si date inconnue. */
export function msUntilReset(
  window: QuotaWindow,
  now: number = Date.now(),
): number | null {
  if (window.resetsAt === null) return null
  const resetsAt = Date.parse(window.resetsAt)
  return Number.isNaN(resetsAt) ? null : resetsAt - now
}

/** « 2 h 14 », « 47 min », « imminent ». */
export function formatCountdown(remainingMs: number): string {
  if (remainingMs <= 0) return 'imminent'
  const minutes = Math.floor(remainingMs / 60_000)
  if (minutes < 1) return 'moins d’une minute'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours < 24) return rest === 0 ? `${hours} h` : `${hours} h ${rest}`
  const days = Math.floor(hours / 24)
  return hours % 24 === 0 ? `${days} j` : `${days} j ${hours % 24} h`
}

/** Heure de reset lisible : « lun. 14h30 » (« lun. 14h » à l'heure pile). */
export function formatResetClock(resetsAt: string | null): string | null {
  if (resetsAt === null) return null
  const date = new Date(resetsAt)
  if (Number.isNaN(date.getTime())) return null
  const minutes = date.getMinutes()
  const clock = minutes === 0
    ? `${date.getHours()}h`
    : `${date.getHours()}h${String(minutes).padStart(2, '0')}`
  return `${WEEKDAYS[date.getDay()]} ${clock}`
}

/** « 5 h · 62% · reset dans 2 h 14 » — le détail au survol d'une jauge. */
export function describeWindow(
  window: QuotaWindow,
  now: number = Date.now(),
): string {
  const parts = [windowTitle(window)]
  if (window.usedPercent !== null) {
    parts.push(`${Math.round(window.usedPercent)}% utilisé`)
  } else {
    parts.push('usage non publié par le provider')
  }
  const remaining = msUntilReset(window, now)
  if (remaining !== null) {
    parts.push(`reset dans ${formatCountdown(remaining)}`)
    const clock = formatResetClock(window.resetsAt)
    if (clock !== null) parts.push(`(${clock})`)
  }
  return parts.join(' · ')
}

/**
 * Fenêtre la plus contraignante d'un provider : la plus consommée, sinon (aucun
 * pourcentage publié — cas claude) celle qui se réinitialise le plus tôt.
 */
export function tightestWindow(
  state: QuotaState | null,
  now: number = Date.now(),
): QuotaWindow | null {
  if (state === null || state.windows.length === 0) return null
  const withPercent = state.windows.filter((window) => window.usedPercent !== null)
  if (withPercent.length > 0) {
    return withPercent.reduce((worst, window) =>
      (window.usedPercent ?? 0) > (worst.usedPercent ?? 0) ? window : worst,
    )
  }
  return state.windows.reduce((soonest, window) => {
    const left = msUntilReset(window, now)
    const best = msUntilReset(soonest, now)
    if (left === null) return soonest
    if (best === null) return window
    return left < best ? window : soonest
  })
}

/**
 * Chip du sélecteur de modèle : « 62% · reset lun. 14h30 », ou juste le reset
 * quand le provider ne publie pas de pourcentage. null = quota inconnu.
 */
export function quotaChipLabel(
  state: QuotaState | null,
  now: number = Date.now(),
): string | null {
  const window = tightestWindow(state, now)
  if (window === null) return null
  const parts: string[] = []
  if (window.usedPercent !== null) parts.push(`${Math.round(window.usedPercent)}%`)
  const clock = formatResetClock(window.resetsAt)
  if (clock !== null) parts.push(`reset ${clock}`)
  return parts.length === 0 ? null : parts.join(' · ')
}

/**
 * Pulse « use it or lose it » : au moins une fenêtre du provider a moins de
 * PULSE_MAX_USED_PERCENT % consommés et se réinitialise dans moins d'une heure.
 * Sans pourcentage publié, pas de pulse : on ne devine pas le quota restant.
 */
export function shouldPulse(
  state: QuotaState | null,
  model: string,
  now: number = Date.now(),
): boolean {
  if (state === null) return false
  const expensive: readonly string[] = EXPENSIVE_MODELS[state.provider]
  if (!expensive.includes(model)) return false
  return state.windows.some((window) => {
    if (window.usedPercent === null || window.usedPercent >= PULSE_MAX_USED_PERCENT) {
      return false
    }
    const remaining = msUntilReset(window, now)
    return remaining !== null && remaining > 0 && remaining <= PULSE_WITHIN_MS
  })
}

/**
 * Franchissements de seuils à notifier pour l'état courant. Fonction d'état, pas
 * d'événement : l'appelant dédoublonne sur `key` (une alerte reste « active »
 * tant que la condition tient, mais ne doit être poussée qu'une fois).
 */
export function quotaAlerts(
  state: QuotaState | null,
  thresholds: QuotaThresholds = DEFAULT_QUOTA_THRESHOLDS,
  now: number = Date.now(),
): QuotaAlert[] {
  if (state === null) return []
  const alerts: QuotaAlert[] = []

  for (const window of state.windows) {
    const scope = `${state.provider}:${window.label}:${window.resetsAt ?? 'none'}`
    const name = `${state.provider} · ${windowTitle(window)}`
    const remaining = msUntilReset(window, now)

    if (thresholds.lastHour && remaining !== null && remaining > 0 && remaining <= HOUR_MS) {
      alerts.push({
        key: `${scope}:last-hour`,
        title: `Dernière heure — ${name}`,
        body: window.usedPercent === null
          ? `Reset dans ${formatCountdown(remaining)}.`
          : `${Math.round(window.usedPercent)}% utilisé, reset dans ${formatCountdown(remaining)}.`,
      })
    }

    if (
      thresholds.usedPercent !== null
      && window.usedPercent !== null
      && window.usedPercent >= thresholds.usedPercent
    ) {
      const clock = formatResetClock(window.resetsAt)
      alerts.push({
        key: `${scope}:used-${thresholds.usedPercent}`,
        title: `Quota ${Math.round(window.usedPercent)}% — ${name}`,
        body: clock === null
          ? `Seuil de ${thresholds.usedPercent}% franchi.`
          : `Seuil de ${thresholds.usedPercent}% franchi, reset ${clock}.`,
      })
    }
  }

  return alerts
}
