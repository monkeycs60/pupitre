import { flushSync } from 'react-dom'
import { useSyncExternalStore } from 'react'

export type ThemePreference = 'dark' | 'night' | 'light' | 'system'
export type ResolvedTheme = Exclude<ThemePreference, 'system'>

export const THEME_OPTIONS: Array<{ value: ThemePreference; label: string; hint: string }> = [
  { value: 'dark', label: 'Sombre', hint: 'Le thème d’origine de Pupitre' },
  { value: 'night', label: 'Nuit', hint: 'Noir profond, moins de violet, pour le soir' },
  { value: 'light', label: 'Clair', hint: 'Fond papier pour les journées lumineuses' },
  { value: 'system', label: 'Système', hint: 'Suit le réglage clair ou sombre du système' },
]

const STORAGE_KEY = 'pupitre.theme'
const listeners = new Set<() => void>()
let preference: ThemePreference = loadPreference()

function loadPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored === 'night' || stored === 'light' || stored === 'system' ? stored : 'dark'
  } catch {
    return 'dark'
  }
}

function systemPrefersLight(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches === true
}

export function resolveTheme(value: ThemePreference, prefersLight = systemPrefersLight()): ResolvedTheme {
  if (value !== 'system') return value
  return prefersLight ? 'light' : 'dark'
}

function paint() {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.theme = resolveTheme(preference)
}

/** À appeler avant le premier rendu : la page s'affiche directement dans le bon thème. */
export function initTheme() {
  paint()
  window.matchMedia?.('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (preference !== 'system') return
    paint()
    for (const listener of listeners) listener()
  })
}

export function setThemePreference(next: ThemePreference) {
  if (next === preference) return
  preference = next
  try { localStorage.setItem(STORAGE_KEY, next) } catch { /* stockage indisponible */ }
  const apply = () => {
    paint()
    for (const listener of listeners) listener()
  }
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  if (typeof document.startViewTransition === 'function' && !reduced) {
    document.startViewTransition(() => flushSync(apply))
  } else {
    apply()
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribe, () => preference, () => preference)
}

export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribe, () => resolveTheme(preference), () => resolveTheme(preference))
}
