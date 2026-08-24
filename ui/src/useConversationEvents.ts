import { useEffect, useState } from 'react'
import { getConversationEvents, getSubtaskEvents } from './api'
import { reconnectDelayMs } from './backoff'
import { appendLiveEvent, mergeReplayAndBuffer } from './mergeEvents'
import type { StoredEvent } from './types'
import { webSocketUrl } from './transport'

export type ConnectionState = 'connecting' | 'open' | 'reconnecting'

export interface ConversationEvents {
  events: StoredEvent[]
  connection: ConnectionState
  retryAt: number | null
}

// Ouvre le WebSocket AVANT de charger le replay : les événements reçus pendant
// le fetch sont bufferisés puis fusionnés (dédup par id), sans fenêtre de perte.
// Même séquence à chaque reconnexion : le replay est refetché en entier et
// fusionné avec ce qui est déjà affiché — la fusion par id la rend idempotente.
// Le canal WS `/ws?conversation=<id>` accepte indifféremment un id de
// conversation ou de sous-tâche ; le replay HTTP, lui, a deux routes distinctes.
// C'est la seule différence entre les deux flux : `kind` la porte.
export type EventsKind = 'conversation' | 'subtask'

export function useConversationEvents(
  conversationId: string | null,
  kind: EventsKind = 'conversation',
): ConversationEvents {
  const [events, setEvents] = useState<StoredEvent[]>([])
  const [connection, setConnection] = useState<ConnectionState>('connecting')
  const [retryAt, setRetryAt] = useState<number | null>(null)

  useEffect(() => {
    setEvents([])
    setConnection('connecting')
    setRetryAt(null)
    if (conversationId === null) return

    let disposed = false
    let socket: WebSocket | null = null
    let abortController: AbortController | null = null
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let failedAttempts = 0

    function connect(id: string) {
      let buffer: StoredEvent[] | null = []
      const controller = new AbortController()
      abortController = controller

      const currentSocket = new WebSocket(
        webSocketUrl(`/ws?conversation=${encodeURIComponent(id)}`),
      )
      socket = currentSocket

      // Perte de connexion (close, error, ou replay injoignable) : on referme
      // tout et on replanifie une connexion complète avec le backoff.
      function dropAndRetry() {
        if (disposed || socket !== currentSocket) return
        socket = null
        controller.abort()
        currentSocket.close()
        failedAttempts += 1
        setConnection('reconnecting')
        const delay = reconnectDelayMs(failedAttempts)
        setRetryAt(Date.now() + delay)
        retryTimer = setTimeout(() => {
          setRetryAt(null)
          connect(id)
        }, delay)
      }

      // Le socket ouvert ne suffit pas : tant que le replay n'est pas remergé,
      // la reconnexion n'est pas réussie. Le compteur de backoff n'est donc
      // remis à zéro qu'après la fusion (sinon un sidecar qui accepte le WS
      // puis échoue sur /events ferait boucler la reconnexion sans délai).
      currentSocket.addEventListener('open', () => {
        if (disposed || socket !== currentSocket) return
        setConnection('open')
        setRetryAt(null)
      })

      currentSocket.addEventListener('message', (message) => {
        if (disposed || socket !== currentSocket) return

        let event: StoredEvent
        try {
          event = JSON.parse(String(message.data)) as StoredEvent
        } catch (error) {
          console.error('Message WebSocket illisible', error)
          return
        }

        if (event.type === 'status' && event.state !== 'running') {
          window.dispatchEvent(new Event('pupitre:turn-complete'))
        }

        if (buffer !== null) buffer.push(event)
        else setEvents((current) => appendLiveEvent(current, event))
      })

      currentSocket.addEventListener('close', dropAndRetry)
      currentSocket.addEventListener('error', dropAndRetry)

      const fetchReplay =
        kind === 'subtask' ? getSubtaskEvents : getConversationEvents

      void fetchReplay(id, controller.signal)
        .then((replay) => {
          if (controller.signal.aborted || disposed) return

          const pending = buffer ?? []
          buffer = null
          setEvents((current) =>
            mergeReplayAndBuffer(replay, [...current, ...pending]),
          )
          failedAttempts = 0
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted || disposed) return
          console.error(error)
          dropAndRetry()
        })
    }

    connect(conversationId)

    return () => {
      disposed = true
      clearTimeout(retryTimer)
      abortController?.abort()
      socket?.close()
    }
  }, [conversationId, kind])

  return { events, connection, retryAt }
}
