import { useSyncExternalStore } from 'react'

export type ReadingWidth = 'narrow' | 'normal' | 'wide'

export interface ReadingPrefs {
  zoom: number
  width: ReadingWidth
}

export const READING_ZOOM_MIN = 0.7
export const READING_ZOOM_MAX = 2
export const READING_ZOOM_STEP = 0.1

const STORAGE_KEY = 'pupitre.reading'
const DEFAULT_PREFS: ReadingPrefs = { zoom: 1, width: 'normal' }
const listeners = new Set<() => void>()
let prefs = load()

function load(): ReadingPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return DEFAULT_PREFS
    const parsed = JSON.parse(raw) as Partial<ReadingPrefs>
    return {
      zoom: clampZoom(typeof parsed.zoom === 'number' ? parsed.zoom : 1),
      width: parsed.width === 'narrow' || parsed.width === 'wide' ? parsed.width : 'normal',
    }
  } catch {
    return DEFAULT_PREFS
  }
}

export function clampZoom(value: number): number {
  const rounded = Math.round(value * 10) / 10
  return Math.min(READING_ZOOM_MAX, Math.max(READING_ZOOM_MIN, rounded))
}

function update(next: ReadingPrefs) {
  if (next.zoom === prefs.zoom && next.width === prefs.width) return
  prefs = next
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)) } catch { /* stockage indisponible */ }
  for (const listener of listeners) listener()
}

export function setReadingZoom(zoom: number) {
  update({ ...prefs, zoom: clampZoom(zoom) })
}

export function stepReadingZoom(direction: 1 | -1) {
  setReadingZoom(prefs.zoom + direction * READING_ZOOM_STEP)
}

export function setReadingWidth(width: ReadingWidth) {
  update({ ...prefs, width })
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useReadingPrefs(): ReadingPrefs {
  return useSyncExternalStore(subscribe, () => prefs, () => prefs)
}

/** Ctrl/Cmd + `=`/`+`/`-`/`0` : renvoie la direction du zoom, `0` pour réinitialiser, ou `null`. */
export function readingZoomShortcut(event: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'key'>): 1 | -1 | 0 | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return null
  if (event.key === '=' || event.key === '+') return 1
  if (event.key === '-' || event.key === '_') return -1
  if (event.key === '0') return 0
  return null
}
