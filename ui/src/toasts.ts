import { useSyncExternalStore } from 'react'

export type ToastTone = 'ok' | 'info' | 'danger'

export interface Toast {
  id: number
  tone: ToastTone
  title: string
  detail?: string
  onOpen?: () => void
  durationMs: number
  leaving: boolean
}

export const TOAST_LIMIT = 4
const DEFAULT_DURATION_MS = 6000

const listeners = new Set<() => void>()
let toasts: Toast[] = []
let nextId = 1

function publish(next: Toast[]) {
  toasts = next
  for (const listener of listeners) listener()
}

export function pushToast(toast: Omit<Toast, 'id' | 'leaving' | 'durationMs'> & { durationMs?: number }): number {
  const id = nextId++
  const entry: Toast = { ...toast, id, durationMs: toast.durationMs ?? DEFAULT_DURATION_MS, leaving: false }
  publish([...toasts, entry].slice(-TOAST_LIMIT))
  return id
}

/** Lance l'animation de sortie ; `removeToast` retire l'entrée quand elle se termine. */
export function dismissToast(id: number) {
  if (!toasts.some((toast) => toast.id === id && !toast.leaving)) return
  publish(toasts.map((toast) => toast.id === id ? { ...toast, leaving: true } : toast))
}

export function removeToast(id: number) {
  publish(toasts.filter((toast) => toast.id !== id))
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(subscribe, () => toasts, () => toasts)
}
