import { useEffect, useRef, useState } from 'react'
import { getFleet, getReviewStatus } from './api'
import { reconnectDelayMs } from './backoff'
import { webSocketUrl } from './transport'
import type { FleetItem, ReviewStatusEvent, ReviewStatusSnapshot } from './types'

const FLEET_HISTORY_KEY = 'pupitre.fleet-history'
export const FLEET_HISTORY_LIMIT = 20

/**
 * Mémoire locale uniquement : le backend ne publie pas encore de résultat
 * final pour un run qui sort du snapshot actif.
 */
export interface FleetHistoryItem extends FleetItem {
  leftActiveAt: string
}

function isFleetItem(value: unknown): value is FleetItem {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Partial<FleetItem>
  return typeof item.id === 'string'
    && (item.kind === 'turn' || item.kind === 'subtask' || item.kind === 'routine' || item.kind === 'review')
    && typeof item.projectId === 'string'
    && typeof item.projectName === 'string'
    && typeof item.conversationId === 'string'
    && typeof item.title === 'string'
    && (item.provider === 'claude' || item.provider === 'codex' || item.provider === 'grok')
    && typeof item.model === 'string'
    && typeof item.startedAt === 'string'
    && typeof item.lastEvent === 'string'
}

function isFleetHistoryItem(value: unknown): value is FleetHistoryItem {
  return isFleetItem(value)
    && typeof (value as FleetHistoryItem).leftActiveAt === 'string'

}

function storage(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function loadFleetHistory(): FleetHistoryItem[] {
  const localStorage = storage()
  if (localStorage === null) return []
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(FLEET_HISTORY_KEY) ?? '[]')
    if (!Array.isArray(parsed)) return []
    const seen = new Set<string>()
    return parsed
      .filter(isFleetHistoryItem)
      .filter((item) => {
        if (seen.has(item.id)) return false
        seen.add(item.id)
        return true
      })
      .slice(0, FLEET_HISTORY_LIMIT)
  } catch {
    return []
  }
}

function persistFleetHistory(history: FleetHistoryItem[]): void {
  const localStorage = storage()
  if (localStorage === null) return
  try {
    localStorage.setItem(FLEET_HISTORY_KEY, JSON.stringify(history.slice(0, FLEET_HISTORY_LIMIT)))
  } catch {
    // Le flux Fleet reste utilisable si le stockage est indisponible ou plein.
  }
}

/**
 * Compare deux snapshots successifs. Seuls les ids réellement sortis du
 * snapshot précédent sont mémorisés ; une reconnexion sans nouveau snapshot
 * ne peut donc pas fabriquer un run terminé.
 */
export function rememberDepartedFleetRuns(
  previous: FleetItem[],
  next: FleetItem[],
  history: FleetHistoryItem[],
  leftActiveAt: string,
): FleetHistoryItem[] {
  const activeIds = new Set(next.map((item) => item.id))
  const retained = history.filter((item) => !activeIds.has(item.id))
  const knownIds = new Set(retained.map((item) => item.id))
  const departed = previous
    .filter((item) => !activeIds.has(item.id) && !knownIds.has(item.id))
    .map((item): FleetHistoryItem => ({
      ...item,
      leftActiveAt,
    }))

  return [...departed.reverse(), ...retained].slice(0, FLEET_HISTORY_LIMIT)
}

function parseFleetSnapshot(value: unknown): FleetItem[] | null {
  if (!Array.isArray(value) || !value.every(isFleetItem)) return null
  return value
}

export interface FleetState {
  items: FleetItem[]
  history: FleetHistoryItem[]
  connected: boolean
  reviewStatus: ReviewStatusSnapshot | null
}

export function useFleet(projectId?: string): FleetState {
  const [items, setItems] = useState<FleetItem[]>([])
  const [history, setHistory] = useState<FleetHistoryItem[]>(loadFleetHistory)
  const [connected, setConnected] = useState(false)
  const [reviewStatus, setReviewStatus] = useState<ReviewStatusSnapshot | null>(null)
  const activeRef = useRef<FleetItem[]>([])
  const historyRef = useRef(history)

  useEffect(() => {
    let disposed = false
    let socket: WebSocket | null = null
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let failedAttempts = 0
    const controller = new AbortController()

    function applySnapshot(snapshot: FleetItem[]) {
      // Le serveur rediffuse le snapshot chaque seconde, identique la plupart
      // du temps : le réinjecter tel quel re-rendait App — donc tout l'arbre —
      // au même rythme. Seuls les vrais changements sont publiés.
      if (JSON.stringify(snapshot) === JSON.stringify(activeRef.current)) return
      const nextHistory = rememberDepartedFleetRuns(
        activeRef.current,
        snapshot,
        historyRef.current,
        new Date().toISOString(),
      )
      activeRef.current = snapshot
      historyRef.current = nextHistory
      setItems(snapshot)
      setHistory(nextHistory)
      persistFleetHistory(nextHistory)
    }

    function connect() {
      const current = new WebSocket(webSocketUrl('/ws?channel=fleet'))
      socket = current
      current.addEventListener('open', () => {
        if (disposed || socket !== current) return
        failedAttempts = 0
        setConnected(true)
      })
      current.addEventListener('message', (message) => {
        if (disposed || socket !== current) return
        try {
          const payload: unknown = JSON.parse(String(message.data))
          if (isReviewStatusEvent(payload)) {
            if (payload.projectId === projectId) setReviewStatus(payload)
            return
          }
          const snapshot = parseFleetSnapshot(payload)
          if (snapshot === null) {
            console.error('Snapshot Fleet invalide')
            return
          }
          applySnapshot(snapshot)
        } catch (error) {
          console.error('Snapshot Fleet illisible', error)
        }
      })
      const retry = () => {
        if (disposed || socket !== current) return
        socket = null
        current.close()
        setConnected(false)
        failedAttempts += 1
        retryTimer = setTimeout(connect, reconnectDelayMs(failedAttempts))
      }
      current.addEventListener('close', retry)
      current.addEventListener('error', retry)
    }

    void getFleet(controller.signal)
      .then((snapshot) => {
        if (disposed) return
        const parsed = parseFleetSnapshot(snapshot)
        if (parsed === null) {
          console.error('Snapshot Fleet invalide')
          return
        }
        applySnapshot(parsed)
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) console.error('Fleet indisponible', error)
      })
    if (projectId) {
      void getReviewStatus(projectId, controller.signal)
        .then((status) => { if (!disposed) setReviewStatus(status) })
        .catch(() => {})
    } else {
      setReviewStatus(null)
    }
    connect()
    return () => {
      disposed = true
      controller.abort()
      clearTimeout(retryTimer)
      socket?.close()
    }
  }, [projectId])

  return { items, history, connected, reviewStatus }
}

function isReviewStatusEvent(value: unknown): value is ReviewStatusEvent {
  if (typeof value !== 'object' || value === null) return false
  const status = value as Partial<ReviewStatusEvent>
  return typeof status.projectId === 'string'
    && typeof status.openBySeverity === 'object' && status.openBySeverity !== null
    && (status.running === null || (typeof status.running === 'object' && status.running !== null))
}
