import { useEffect, useRef, useState } from 'react'
import { getProjectDashboard } from './api'
import { reconnectDelayMs } from './backoff'
import { webSocketUrl } from './transport'
import type { DashboardPayload } from './types'

export interface DashboardState {
  data: DashboardPayload | null
  connected: boolean
  error: string | null
}

function isDashboardPayload(value: unknown): value is DashboardPayload {
  if (typeof value !== 'object' || value === null) return false
  const payload = value as Partial<DashboardPayload>
  return typeof payload.projectId === 'string'
    && typeof payload.refreshedAt === 'string'
    && Array.isArray(payload.integrations)
    && Array.isArray(payload.tickets)
    && Array.isArray(payload.environments)
    && Array.isArray(payload.toReview)
}

function shouldReplace(current: DashboardPayload | null, next: DashboardPayload): boolean {
  return current === null || current.refreshedAt <= next.refreshedAt
}

export function useDashboard(projectId: string): DashboardState {
  const [data, setData] = useState<DashboardPayload | null>(null)
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dataRef = useRef<DashboardPayload | null>(null)

  useEffect(() => {
    let disposed = false
    let socket: WebSocket | null = null
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let failedAttempts = 0
    const controller = new AbortController()

    dataRef.current = null
    setData(null)
    setConnected(false)
    setError(null)

    function applySnapshot(snapshot: DashboardPayload) {
      if (!shouldReplace(dataRef.current, snapshot)) return
      dataRef.current = snapshot
      setData(snapshot)
      setError(null)
    }

    function connect() {
      const current = new WebSocket(
        webSocketUrl(`/ws?channel=tickets&project=${encodeURIComponent(projectId)}`),
      )
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
          if (isDashboardPayload(payload)) applySnapshot(payload)
        } catch {}
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

    void getProjectDashboard(projectId, controller.signal)
      .then((snapshot) => {
        if (disposed) return
        applySnapshot(snapshot)
      })
      .catch((loadError: unknown) => {
        if (disposed || controller.signal.aborted) return
        setError(loadError instanceof Error ? loadError.message : String(loadError))
      })

    connect()

    return () => {
      disposed = true
      controller.abort()
      clearTimeout(retryTimer)
      socket?.close()
    }
  }, [projectId])

  return { data, connected, error }
}
