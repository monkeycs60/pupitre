import { useCallback, useSyncExternalStore } from 'react'
import { launchRequest } from './api'

export interface LaunchUrl {
  url: string
  port: number
  front: boolean
  live: boolean
}

export interface LaunchCommand {
  env_json?: string
  id: string
  project_id: string
  name: string
  command: string
  cwd_relative: string
  port: number | null
  kind: string
  running?: boolean
  logs?: string
  url?: string | null
  urls?: LaunchUrl[]
}

const EMPTY: LaunchCommand[] = []
const snapshots = new Map<string, LaunchCommand[]>()
const listeners = new Map<string, Set<() => void>>()
const timers = new Map<string, ReturnType<typeof setInterval>>()

export async function refreshProjectLaunches(projectId: string): Promise<LaunchCommand[]> {
  const items = await launchRequest<LaunchCommand[]>(`/api/projects/${projectId}/launch`)
  snapshots.set(projectId, items)
  for (const listener of listeners.get(projectId) ?? []) listener()
  return items
}

function subscribe(projectId: string, listener: () => void): () => void {
  const set = listeners.get(projectId) ?? new Set()
  listeners.set(projectId, set)
  set.add(listener)
  if (set.size === 1) {
    void refreshProjectLaunches(projectId).catch(() => {})
    timers.set(projectId, setInterval(() => void refreshProjectLaunches(projectId).catch(() => {}), 4_000))
  }
  return () => {
    set.delete(listener)
    if (set.size === 0) {
      clearInterval(timers.get(projectId))
      timers.delete(projectId)
    }
  }
}

export function useProjectLaunches(projectId: string): LaunchCommand[] {
  const subscribeProject = useCallback(
    (listener: () => void) => subscribe(projectId, listener),
    [projectId],
  )
  return useSyncExternalStore(
    subscribeProject,
    () => snapshots.get(projectId) ?? EMPTY,
    () => EMPTY,
  )
}

export function launchUrlLabel(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '')
}
