import { useSyncExternalStore } from 'react'
import { getRunningApplications, type RunningApplication } from './api'

interface RunningApplicationsSnapshot {
  items: RunningApplication[]
  loading: boolean
  error: string | null
  updatedAt: number | null
}

const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null
let refreshing = false
let snapshot: RunningApplicationsSnapshot = {
  items: [],
  loading: true,
  error: null,
  updatedAt: null,
}

function publish(next: RunningApplicationsSnapshot): void {
  snapshot = next
  for (const listener of listeners) listener()
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

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) {
    void refreshRunningApplications()
    timer = setInterval(() => void refreshRunningApplications(), 5_000)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }
}

export function useRunningApplications(): RunningApplicationsSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot)
}
