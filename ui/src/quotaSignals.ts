import type { Provider, QuotaSnapshot, QuotaState, QuotaWindow } from './types'

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
const TWO_DAYS_MS = 2 * 24 * HOUR_MS
const WEEKDAYS = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.']

export interface QuotaWindowSignals {
  /** Dernière heure de la fenêtre Claude de 5 h. */
  lastHour: boolean
  /** Deux derniers jours d'une fenêtre hebdomadaire Claude ou Codex. */
  weeklyEnding: boolean
}

function isFiveHourWindow(window: QuotaWindow): boolean {
  return window.label === 'five_hour' || window.windowDurationMins === 300
}

function isWeeklyWindow(window: QuotaWindow): boolean {
  return window.label === 'seven_day'
    || window.label === 'weekly'
    || window.label === 'opus_weekly'
    || window.label.startsWith('seven_day_')
    || window.windowDurationMins === 10_080
}

/** Signaux temporels visuels d'une fenêtre, indépendants et donc cumulables. */
export function quotaWindowSignals(
  provider: Provider,
  window: QuotaWindow,
  now: number = Date.now(),
): QuotaWindowSignals {
  const remaining = msUntilReset(window, now)
  if (remaining === null || remaining <= 0) {
    return { lastHour: false, weeklyEnding: false }
  }
  return {
    lastHour: provider === 'claude'
      && isFiveHourWindow(window)
      && remaining <= HOUR_MS,
    weeklyEnding: isWeeklyWindow(window) && remaining <= TWO_DAYS_MS,
  }
}

/** Agrège les signaux sans en écraser un par l'autre. */
export function quotaStateSignals(
  provider: Provider,
  state: QuotaState | null,
  now: number = Date.now(),
): QuotaWindowSignals {
  if (state === null) return { lastHour: false, weeklyEnding: false }
  return state.windows.reduce<QuotaWindowSignals>((combined, window) => {
    const signals = quotaWindowSignals(provider, window, now)
    return {
      lastHour: combined.lastHour || signals.lastHour,
      weeklyEnding: combined.weeklyEnding || signals.weeklyEnding,
    }
  }, { lastHour: false, weeklyEnding: false })
}

/** Libellés lisibles des fenêtres, sinon la durée, sinon le label brut. */
export function windowTitle(window: QuotaWindow): string {
  switch (window.label) {
    case 'five_hour':
      return '5 h'
    case 'seven_day':
    case 'weekly':
      return 'hebdo'
    case 'opus_weekly':
      return 'hebdo opus'
    case 'primary':
    case 'secondary':
      // Les noms primary/secondary ne garantissent pas la durée : la fixture
      // réelle Codex publie notamment une fenêtre primary hebdomadaire.
      if (window.windowDurationMins === 300) return '5 h'
      if (window.windowDurationMins === 10_080) return 'hebdo'
      break
    default:
      break
  }
  // Fenêtre hebdomadaire scopée à un modèle : `seven_day_fable` → « hebdo fable ».
  // C'est ce que publie /api/oauth/usage pour les limites `weekly_scoped`.
  if (window.label.startsWith('seven_day_')) {
    return `hebdo ${window.label.slice('seven_day_'.length).replace(/-/g, ' ')}`
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

export interface QuotaSummary {
  /** Pourcentage consommé, ou null quand le provider n'en publie pas. */
  usedPercent: number | null
  /** Ligne principale : « 62 % utilisé », « reset dans 4 h », « jamais relevé ». */
  headline: string
  /** Pourquoi il manque une information, ou la précision utile. */
  note: string | null
}

/**
 * Ce que l'on sait vraiment du quota d'un provider, en une ligne lisible.
 *
 * Une donnée manquante est nommée, jamais devinée ni masquée derrière un
 * « inconnu » qui se lirait comme une panne. Côté claude, un relevé sans
 * pourcentage signifie qu'on tient la source de repli (le `rate_limit_event`
 * d'un tour) et pas le relevé d'usage complet.
 */
export function quotaSummary(
  provider: Provider,
  state: QuotaState | null,
  now: number = Date.now(),
): QuotaSummary {
  const window = tightestWindow(state, now)
  if (window === null) {
    return {
      usedPercent: null,
      headline: 'jamais relevé',
      note: provider === 'claude'
        ? 'Usage illisible : session Claude Code absente ou expirée. Relancez `claude` puis actualisez.'
        : 'Aucun relevé reçu de l’app-server codex.',
    }
  }

  const remaining = msUntilReset(window, now)
  const countdown = remaining === null ? null : formatCountdown(remaining)
  const reset = countdown === null
    ? null
    : countdown === 'imminent' ? 'reset imminent' : `reset dans ${countdown}`

  if (window.usedPercent === null) {
    return {
      usedPercent: null,
      headline: reset ?? 'fenêtre en cours',
      note: 'Relevé partiel, issu du flux d’un tour. Actualisez pour lire l’usage complet.',
    }
  }
  return {
    usedPercent: window.usedPercent,
    headline: `${Math.round(window.usedPercent)} % utilisé`,
    note: reset === null ? null : `${windowTitle(window)} · ${reset}`,
  }
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

/**
 * Prochain instant où une fenêtre connue entrera dans sa dernière heure.
 * Les seuils en pourcentage ne dépendent pas du temps et attendent un nouveau
 * snapshot provider ; seule l'alerte temporelle nécessite ce réveil local.
 */
export function nextQuotaReevaluationDelay(
  snapshot: QuotaSnapshot,
  thresholds: QuotaThresholds,
  now: number = Date.now(),
): number | null {
  if (!thresholds.lastHour) return null
  let next: number | null = null
  for (const state of Object.values(snapshot)) {
    if (state === null) continue
    for (const window of state.windows) {
      const remaining = msUntilReset(window, now)
      if (remaining === null || remaining <= HOUR_MS) continue
      const delay = remaining - HOUR_MS
      next = next === null ? delay : Math.min(next, delay)
    }
  }
  return next
}

/** Âge lisible du relevé provider le plus récent. */
export function quotaFreshness(
  snapshot: QuotaSnapshot,
  now: number = Date.now(),
): string | null {
  const timestamps = Object.values(snapshot).flatMap((state) => {
    if (state === null) return []
    const timestamp = Date.parse(state.updatedAt)
    return Number.isNaN(timestamp) ? [] : [timestamp]
  })
  if (timestamps.length === 0) return null

  const elapsedMs = Math.max(0, now - Math.max(...timestamps))
  const minutes = Math.floor(elapsedMs / 60_000)
  if (minutes < 1) return 'mis à jour à l’instant'
  if (minutes < 60) return `mis à jour il y a ${minutes} min`
  return `mis à jour il y a ${Math.floor(minutes / 60)} h`
}
