import { useEffect, useState } from 'react'
import { getConversationEvents } from './api'
import type { AppEvent } from './types'

// Charge le replay avant de s'abonner aux nouveaux événements en WebSocket.
export function useConversationEvents(
  conversationId: string | null,
): AppEvent[] {
  const [events, setEvents] = useState<AppEvent[]>([])

  useEffect(() => {
    setEvents([])
    if (conversationId === null) return

    const abortController = new AbortController()
    let socket: WebSocket | null = null

    void getConversationEvents(conversationId, abortController.signal)
      .then((replay) => {
        if (abortController.signal.aborted) return

        setEvents(replay)
        socket = new WebSocket(
          `ws://${location.host}/ws?conversation=${encodeURIComponent(conversationId)}`,
        )
        socket.addEventListener('message', (message) => {
          const event = JSON.parse(String(message.data)) as AppEvent
          setEvents((current) => [...current, event])
        })
      })
      .catch((error: unknown) => {
        if (!abortController.signal.aborted) console.error(error)
      })

    return () => {
      abortController.abort()
      socket?.close()
    }
  }, [conversationId])

  return events
}
