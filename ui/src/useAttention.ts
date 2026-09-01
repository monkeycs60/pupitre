import { useCallback, useEffect, useState } from 'react'
import { acknowledgeAttentionItem, listAttentionItems } from './api'
import type { AttentionItem } from './types'

export function useAttention(projectId?: string | null) {
  const [items, setItems] = useState<AttentionItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback((signal?: AbortSignal) => {
    setLoading(true)
    return listAttentionItems(projectId, signal)
      .then((next) => { setItems(next); setError(null) })
      .catch((reason: unknown) => {
        if (!signal?.aborted) setError(reason instanceof Error ? reason.message : 'Inbox indisponible')
      })
      .finally(() => { if (!signal?.aborted) setLoading(false) })
  }, [projectId])

  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal)
    const timer = window.setInterval(() => void refresh(), 15_000)
    return () => { controller.abort(); window.clearInterval(timer) }
  }, [refresh])

  async function acknowledge(id: string) {
    await acknowledgeAttentionItem(id)
    setItems((current) => current.filter((item) => item.id !== id))
  }

  return { items, loading, error, refresh, acknowledge }
}
