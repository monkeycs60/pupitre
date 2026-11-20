import { useCallback, useEffect, useState } from 'react'
import { listViewedConversations } from './api'
import type { ViewedConversation } from './types'

const FETCH_LIMIT = 10

export function useViewedConversations() {
  const [items, setItems] = useState<ViewedConversation[] | null>(null)
  const [error, setError] = useState(false)

  const refresh = useCallback(() => listViewedConversations(FETCH_LIMIT)
    .then((next) => { setItems(next); setError(false) })
    .catch(() => setError(true)), [])

  useEffect(() => { void refresh() }, [refresh])

  return { items, error, refresh }
}
