import { useEffect } from 'react'
import { listNotifications } from './api'
import type { AppNotification } from './types'

const CURSOR_KEY = 'pupitre.notification-cursor'

function loadCursor(): number | null {
  try {
    const raw = localStorage.getItem(CURSOR_KEY)
    if (raw === null) return null
    const parsed = Number(raw)
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
  } catch {
    return null
  }
}

function persistCursor(cursor: number): void {
  try {
    localStorage.setItem(CURSOR_KEY, String(cursor))
  } catch {
    // La déduplication tient au moins jusqu'au prochain rechargement.
  }
}

async function showNotification(item: AppNotification): Promise<void> {
  if (typeof Notification === 'undefined') return
  let permission = Notification.permission
  if (permission === 'default') permission = await Notification.requestPermission()
  if (permission !== 'granted') return
  new Notification(item.title, { body: item.body, tag: `pupitre-${item.id}` })
}

/** Synchronise le canal persistant du sidecar avec les notifications natives. */
export function useAppNotifications(): void {
  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let cursor = loadCursor()

    async function poll() {
      try {
        const items = await listNotifications(cursor ?? 0)
        if (disposed) return
        const latest = items.at(-1)?.id
        if (cursor === null) {
          // Premier démarrage : les anciennes alertes servent de baseline.
          cursor = latest ?? 0
        } else {
          for (const item of items) await showNotification(item)
          if (latest !== undefined) cursor = latest
        }
        persistCursor(cursor)
      } catch (error) {
        if (!disposed) console.error('Notifications Pupitre indisponibles', error)
      } finally {
        if (!disposed) timer = setTimeout(() => void poll(), 2_000)
      }
    }

    void poll()
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [])
}
