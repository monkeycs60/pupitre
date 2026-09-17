import { useCallback, useEffect, useState } from 'react'
import { listUnreadConversations, markConversationRead } from './api'
import type { UnreadConversation } from './types'

export function useUnreadConversations(refreshVersion = 0) {
  const [items, setItems] = useState<UnreadConversation[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback((signal?: AbortSignal) => {
    setLoading(true)
    return listUnreadConversations(signal)
      .then((next) => { setItems(next); setError(null) })
      .catch((reason: unknown) => {
        if (!signal?.aborted) setError(reason instanceof Error ? reason.message : 'Conversations indisponibles')
      })
      .finally(() => { if (!signal?.aborted) setLoading(false) })
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal)
    const timer = window.setInterval(() => void refresh(), 15_000)
    return () => { controller.abort(); window.clearInterval(timer) }
  }, [refresh, refreshVersion])

  async function read(item: UnreadConversation) {
    await markConversationRead(item.id, item.answered_turn)
    setItems((current) => current.filter((candidate) => candidate.id !== item.id))
  }

  return { items, loading, error, refresh, read }
}
