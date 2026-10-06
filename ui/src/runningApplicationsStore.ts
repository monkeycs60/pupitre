import { useCallback, useSyncExternalStore } from 'react'
import { getRunningApplications, type RunningApplication } from './api'

interface RunningApplicationsSnapshot {
  items: RunningApplication[]
  loading: boolean
  error: string | null
  updatedAt: number | null
}

const listeners = new Map<() => void, number>()
let timer: ReturnType<typeof setInterval> | null = null
let timerInterval: number | null = null
let refreshing = false
let snapshot: RunningApplicationsSnapshot = {
  items: [],
  loading: true,
  error: null,
  updatedAt: null,
}

function publish(next: RunningApplicationsSnapshot): void {
  snapshot = next
  for (const listener of listeners.keys()) listener()
}

export async function refreshRunningApplications(): Promise<void> {
  if (refreshing) return
  refreshing = true
  if (snapshot.updatedAt === null) publish({ ...snapshot, loading: true, error: null })
  try {
    const items = await getRunningApplications()
    publish({ items, loading: false, error: null, updatedAt: Date.now() })
  } catch (reason) {
    publish({
      ...snapshot,
      loading: false,
      error: reason instanceof Error ? reason.message : 'Détection impossible',
    })
  } finally {
    refreshing = false
  }
}

function schedule(): void {
  const interval = listeners.size === 0 ? null : Math.min(...listeners.values())
  if (interval === timerInterval) return
  if (timer !== null) clearInterval(timer)
  timer = interval === null ? null : setInterval(() => void refreshRunningApplications(), interval)
  timerInterval = interval
}

function subscribe(listener: () => void, intervalMs: number): () => void {
  const first = listeners.size === 0
  listeners.set(listener, intervalMs)
  if (first || (snapshot.updatedAt !== null && Date.now() - snapshot.updatedAt > intervalMs)) void refreshRunningApplications()
  schedule()
  return () => {
    listeners.delete(listener)
    schedule()
  }
}

export function useRunningApplications(intervalMs = 5_000): RunningApplicationsSnapshot {
  const subscribeAt = useCallback((listener: () => void) => subscribe(listener, intervalMs), [intervalMs])
  return useSyncExternalStore(subscribeAt, () => snapshot, () => snapshot)
}
