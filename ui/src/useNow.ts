import { useCallback, useSyncExternalStore } from 'react'

// Horloge partagée des affichages de quota : les compte à rebours se
// rafraîchissent à la demi-minute, suffisant pour un « reset dans 2 h 14 ».
const TICK_MS = 30_000

interface Clock {
  now: number
  listeners: Set<() => void>
  timer: ReturnType<typeof setInterval> | null
}

const clocks = new Map<number, Clock>()

function clockFor(tickMs: number): Clock {
  let clock = clocks.get(tickMs)
  if (clock === undefined) {
    clock = { now: Date.now(), listeners: new Set(), timer: null }
    clocks.set(tickMs, clock)
  }
  return clock
}

export function useNow(tickMs: number = TICK_MS): number {
  const clock = clockFor(tickMs)
  const subscribe = useCallback((listener: () => void) => {
    clock.listeners.add(listener)
    if (clock.timer === null) {
      clock.timer = setInterval(() => {
        clock.now = Date.now()
        for (const notify of clock.listeners) notify()
      }, tickMs)
    }
    return () => {
      clock.listeners.delete(listener)
      if (clock.listeners.size === 0 && clock.timer !== null) {
        clearInterval(clock.timer)
        clock.timer = null
      }
    }
  }, [clock, tickMs])
  return useSyncExternalStore(
    subscribe,
    () => clock.now,
    () => clock.now,
  )
}
