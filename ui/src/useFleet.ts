import { useEffect, useState } from 'react'
import { getFleet } from './api'
import { reconnectDelayMs } from './backoff'
import { webSocketUrl } from './transport'
import type { FleetItem } from './types'

export function useFleet(): { items: FleetItem[]; connected: boolean } {
  const [items, setItems] = useState<FleetItem[]>([])
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    let disposed = false
    let socket: WebSocket | null = null
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let failedAttempts = 0
    const controller = new AbortController()

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
          setItems(JSON.parse(String(message.data)) as FleetItem[])
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
      .then((snapshot) => { if (!disposed) setItems(snapshot) })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) console.error('Fleet indisponible', error)
      })
    connect()
    return () => {
      disposed = true
      controller.abort()
      clearTimeout(retryTimer)
      socket?.close()
    }
  }, [])

  return { items, connected }
}
