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
  project_name?: string | null
  name: string
  command: string
  cwd_relative: string
  port: number | null
  kind: string
  running?: boolean
  cwd?: string
  logs?: string
  url?: string | null
  urls?: LaunchUrl[]
}

export const ALL_LAUNCHES = '/api/launches?logs=0'

const EMPTY: LaunchCommand[] = []
const snapshots = new Map<string, LaunchCommand[]>()
const listeners = new Map<string, Set<() => void>>()
const timers = new Map<string, ReturnType<typeof setInterval>>()

function projectPath(projectId: string): string {
  return `/api/projects/${projectId}/launch`
}

async function refresh(path: string): Promise<LaunchCommand[]> {
  const items = await launchRequest<LaunchCommand[]>(path)
  snapshots.set(path, items)
  for (const listener of listeners.get(path) ?? []) listener()
  return items
}

export async function refreshProjectLaunches(projectId: string): Promise<LaunchCommand[]> {
  if (listeners.get(ALL_LAUNCHES)?.size) void refresh(ALL_LAUNCHES).catch(() => {})
  return refresh(projectPath(projectId))
}

function subscribe(path: string, listener: () => void): () => void {
  const set = listeners.get(path) ?? new Set()
  listeners.set(path, set)
  set.add(listener)
  if (set.size === 1) {
    void refresh(path).catch(() => {})
    timers.set(path, setInterval(() => void refresh(path).catch(() => {}), 4_000))
  }
  return () => {
    set.delete(listener)
    if (set.size === 0) {
      clearInterval(timers.get(path))
      timers.delete(path)
    }
  }
}

export function useLaunches(path: string): LaunchCommand[] {
  const subscribePath = useCallback(
    (listener: () => void) => subscribe(path, listener),
    [path],
  )
  return useSyncExternalStore(
    subscribePath,
    () => snapshots.get(path) ?? EMPTY,
    () => EMPTY,
  )
}

export function useProjectLaunches(projectId: string): LaunchCommand[] {
  return useLaunches(projectPath(projectId))
}

export function launchUrlLabel(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '')
}
