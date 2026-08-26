import { useEffect, useState } from 'react'
import { getConversationEventPage, getSubtaskEventPage } from './api'
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

const replayCache = new Map<string, StoredEvent[]>()
const MAX_CACHED_REPLAYS = 12

function cacheKey(id: string, kind: EventsKind): string {
  return `${kind}:${id}`
}

function cacheReplay(key: string, events: StoredEvent[]): void {
  replayCache.delete(key)
  replayCache.set(key, events)
  if (replayCache.size > MAX_CACHED_REPLAYS) {
    replayCache.delete(replayCache.keys().next().value as string)
  }
}

function mergeLatestPage(
  replay: StoredEvent[],
  visible: StoredEvent[],
  pending: StoredEvent[],
): StoredEvent[] {
  if (replay.length === 0) {
    let next = visible
    for (const event of pending) next = appendLiveEvent(next, event)
    return next
  }
  const firstReplayId = replay[0]?.id ?? Number.POSITIVE_INFINITY
  const older = visible.filter((event) => event.id < firstReplayId)
  return [...older, ...mergeReplayAndBuffer(replay, [...visible, ...pending])]
}

function prependHistoricalPage(page: StoredEvent[], current: StoredEvent[]): StoredEvent[] {
  const byId = new Map(page.map((event) => [event.id, event]))
  for (const event of current) byId.set(event.id, event)
  return [...byId.values()].sort((left, right) => left.id - right.id)
}

export function useConversationEvents(
  conversationId: string | null,
  kind: EventsKind = 'conversation',
): ConversationEvents {
  const selectedKey = conversationId === null ? null : cacheKey(conversationId, kind)
  const [eventState, setEventState] = useState<{ key: string | null; events: StoredEvent[] }>(() => ({
    key: selectedKey,
    events: selectedKey === null ? [] : replayCache.get(selectedKey) ?? [],
  }))
  const [connection, setConnection] = useState<ConnectionState>('connecting')
  const [retryAt, setRetryAt] = useState<number | null>(null)

  useEffect(() => {
    const key = conversationId === null ? null : cacheKey(conversationId, kind)
    setEventState({ key, events: key === null ? [] : replayCache.get(key) ?? [] })
    setConnection('connecting')
    setRetryAt(null)
    if (conversationId === null) return

    let disposed = false
    let socket: WebSocket | null = null
    let abortController: AbortController | null = null
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let olderPageTimer: ReturnType<typeof setTimeout> | undefined
    let frame: number | null = null
    let frameBuffer: StoredEvent[] = []
    let failedAttempts = 0

    function flushFrame() {
      frame = null
      const pending = frameBuffer
      frameBuffer = []
      if (pending.length === 0) return
      setEventState((current) => {
        const base = current.key === key ? current.events : replayCache.get(key!) ?? []
        let next = base
        for (const event of pending) next = appendLiveEvent(next, event)
        if (key !== null) cacheReplay(key, next)
        return { key, events: next }
      })
    }

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
        else {
          frameBuffer.push(event)
          frame ??= requestAnimationFrame(flushFrame)
        }
      })

      currentSocket.addEventListener('close', dropAndRetry)
      currentSocket.addEventListener('error', dropAndRetry)

      const fetchReplayPage = kind === 'subtask'
        ? getSubtaskEventPage
        : getConversationEventPage

      void fetchReplayPage(id, null, controller.signal)
        .then((page) => {
          if (controller.signal.aborted || disposed) return

          const pending = buffer ?? []
          buffer = null
          setEventState((current) => {
            const visible = current.key === key ? current.events : replayCache.get(key!) ?? []
            const next = mergeLatestPage(page.events, visible, pending)
            if (key !== null) cacheReplay(key, next)
            return { key, events: next }
          })
          failedAttempts = 0

          const loadOlder = (before: number | null) => {
            if (before === null || controller.signal.aborted || disposed) return
            void fetchReplayPage(id, before, controller.signal).then((older) => {
              if (controller.signal.aborted || disposed) return
              setEventState((current) => {
                const visible = current.key === key ? current.events : replayCache.get(key!) ?? []
                const next = prependHistoricalPage(older.events, visible)
                if (key !== null) cacheReplay(key, next)
                return { key, events: next }
              })
              olderPageTimer = setTimeout(() => loadOlder(older.nextBefore), 16)
            }).catch((error: unknown) => {
              if (!controller.signal.aborted && !disposed) console.error(error)
            })
          }
          olderPageTimer = setTimeout(() => loadOlder(page.nextBefore), 16)
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
      clearTimeout(olderPageTimer)
      if (frame !== null) cancelAnimationFrame(frame)
      abortController?.abort()
      socket?.close()
    }
  }, [conversationId, kind])

  const events = eventState.key === selectedKey
    ? eventState.events
    : selectedKey === null ? [] : replayCache.get(selectedKey) ?? []
  return { events, connection, retryAt }
}
