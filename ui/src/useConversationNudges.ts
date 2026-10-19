import { useCallback, useEffect, useState } from 'react'
import { closeConversationNudge, listConversationNudges, restoreConversationNudge, snoozeConversationNudge } from './api'
import type { ConversationNudge } from './types'

const POLL_MS = 20_000
export const SNOOZE_MINUTES = 30

export function useConversationNudges() {
  const [items, setItems] = useState<ConversationNudge[]>([])

  const refresh = useCallback((signal?: AbortSignal) => listConversationNudges(signal)
    .then(setItems)
    .catch(() => {}), [])

  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal)
    const timer = window.setInterval(() => void refresh(), POLL_MS)
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    return () => { controller.abort(); window.clearInterval(timer); window.removeEventListener('focus', onFocus) }
  }, [refresh])

  const patch = (id: string, next: Partial<ConversationNudge>) =>
    setItems((current) => current.map((item) => item.id === id ? { ...item, ...next } : item))

  return {
    items,
    remove: (id: string) => setItems((current) => current.filter((item) => item.id !== id)),
    async dismiss(id: string) {
      patch(id, { parked: 'dismissed' })
      await closeConversationNudge(id).catch(() => {})
    },
    async snooze(id: string) {
      patch(id, { parked: 'snoozed', snoozed_until: new Date(Date.now() + SNOOZE_MINUTES * 60_000).toISOString() })
      await snoozeConversationNudge(id, SNOOZE_MINUTES).catch(() => {})
    },
    async restore(id: string) {
      patch(id, { parked: null, snoozed_until: null })
      await restoreConversationNudge(id).catch(() => {})
    },
  }
}

export type ConversationNudges = ReturnType<typeof useConversationNudges>
