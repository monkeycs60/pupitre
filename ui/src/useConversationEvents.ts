import { useEffect, useState } from 'react'
import { getConversationEvents } from './api'
import { mergeReplayAndBuffer } from './mergeEvents'
import type { StoredEvent } from './types'

// Ouvre le WebSocket AVANT de charger le replay : les événements reçus pendant
// le fetch sont bufferisés puis fusionnés (dédup par id), sans fenêtre de perte.
export function useConversationEvents(
  conversationId: string | null,
): StoredEvent[] {
  const [events, setEvents] = useState<StoredEvent[]>([])

  useEffect(() => {
    setEvents([])
    if (conversationId === null) return

    const abortController = new AbortController()
    let buffer: StoredEvent[] | null = []

    const socket = new WebSocket(
      `ws://${location.host}/ws?conversation=${encodeURIComponent(conversationId)}`,
    )
    socket.addEventListener('message', (message) => {
      let event: StoredEvent
      try {
        event = JSON.parse(String(message.data)) as StoredEvent
      } catch (error) {
        console.error('Message WebSocket illisible', error)
        return
      }
      if (buffer !== null) buffer.push(event)
      else setEvents((current) => mergeReplayAndBuffer(current, [event]))
    })

    void getConversationEvents(conversationId, abortController.signal)
      .then((replay) => {
        if (abortController.signal.aborted) return

        setEvents(mergeReplayAndBuffer(replay, buffer ?? []))
        buffer = null
      })
      .catch((error: unknown) => {
        if (!abortController.signal.aborted) console.error(error)
      })

    return () => {
      abortController.abort()
      socket.close()
    }
  }, [conversationId])

  return events
}
