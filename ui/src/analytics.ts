import { ApiError, postUiEvents, type UiEventPayload } from './api'
import type { UiEventName, UiEventProps } from './usageCatalog'

export const USAGE_BUFFER_MAX = 500
export const USAGE_BATCH_MAX = 200
export const USAGE_FLUSH_MS = 10_000

export function createUsageTracker(send: (events: UiEventPayload[], keepalive: boolean) => Promise<void>) {
  let buffer: UiEventPayload[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let listening = false

  function schedule() {
    if (timer !== null || buffer.length === 0) return
    timer = setTimeout(() => {
      timer = null
      flush()
    }, USAGE_FLUSH_MS)
  }

  async function deliver(batch: UiEventPayload[], keepalive: boolean) {
    try {
      await send(batch, keepalive)
    } catch (error) {
      if (error instanceof ApiError && error.status < 500) return
      buffer = [...batch, ...buffer].slice(-USAGE_BUFFER_MAX)
      schedule()
    }
  }

  function flush(keepalive = false) {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    // Un `send` qui lève avant sa première attente remet son lot en file sur-le-champ :
    // vider `buffer` lui-même boucle alors sans fin.
    const pending = buffer
    buffer = []
    for (let start = 0; start < pending.length; start += USAGE_BATCH_MAX) {
      void deliver(pending.slice(start, start + USAGE_BATCH_MAX), keepalive)
    }
  }

  function listen() {
    if (listening) return
    listening = true
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush(true)
    })
    window.addEventListener('pagehide', () => flush(true))
  }

  function track<N extends UiEventName>(name: N, props?: UiEventProps<N>, projectId?: string | null) {
    try {
      buffer.push({
        at: new Date().toISOString(),
        name,
        ...(projectId ? { projectId } : {}),
        ...(props ? { props } : {}),
      })
      if (buffer.length > USAGE_BUFFER_MAX) buffer.splice(0, buffer.length - USAGE_BUFFER_MAX)
      listen()
      schedule()
    } catch {
      // Appelé depuis les gestionnaires de l'interface : une exception ici interromprait l'action mesurée.
    }
  }

  function reset() {
    if (timer !== null) clearTimeout(timer)
    timer = null
    buffer = []
  }

  return { track, flush, reset, pending: () => buffer.length }
}

export const usageTracker = createUsageTracker(postUiEvents)
export const { track } = usageTracker
