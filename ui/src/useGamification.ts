import { useEffect, useMemo, useRef, useState } from 'react'
import { addGamificationActivity, getGamification } from './api'
import type { GamificationSnapshot } from './types'

const ACTIVE_IDLE_LIMIT_MS = 5 * 60_000
const TICK_MS = 1_000
const FLUSH_MS = 15_000
const ACTIVE_STEP_MS = 10 * 60_000
const MAX_ACTIVE_STEPS = 143

function localDay(value = new Date()): string {
  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function focusMultiplier(activeMs: number): number {
  const steps = Math.min(MAX_ACTIVE_STEPS, Math.floor(Math.max(0, activeMs) / ACTIVE_STEP_MS))
  return Number((1 + steps * 0.03).toFixed(2))
}

export interface GamificationPulse {
  id: number
  amount: number
}

export function useGamification(): {
  snapshot: GamificationSnapshot | null
  xpPulse: GamificationPulse | null
} {
  const [snapshot, setSnapshot] = useState<GamificationSnapshot | null>(null)
  const [activeMs, setActiveMs] = useState<number | null>(null)
  const [xpPulse, setXpPulse] = useState<GamificationPulse | null>(null)
  const lastXp = useRef<number | null>(null)
  const pulseId = useRef(0)
  const pendingByDay = useRef(new Map<string, number>())
  const flushing = useRef(false)

  useEffect(() => {
    let disposed = false
    async function load() {
      try {
        const next = await getGamification()
        if (disposed) return
        if (lastXp.current !== null && next.xp > lastXp.current) {
          pulseId.current += 1
          setXpPulse({ id: pulseId.current, amount: next.xp - lastXp.current })
        }
        lastXp.current = next.xp
        setSnapshot(next)
        setActiveMs(next.activeMsToday)
      } catch {
        // La gamification reste une couche de confort : elle ne doit jamais
        // empêcher l'ouverture ou l'utilisation d'une conversation.
      }
    }
    void load()
    const poll = window.setInterval(() => { void load() }, 30_000)
    const refreshOnTurnComplete = () => { void load() }
    window.addEventListener('pupitre:turn-complete', refreshOnTurnComplete)
    return () => {
      disposed = true
      window.clearInterval(poll)
      window.removeEventListener('pupitre:turn-complete', refreshOnTurnComplete)
    }
  }, [])

  useEffect(() => {
    const lastActivityAt = { value: 0 }
    const focused = { value: document.hasFocus() }

    const markActivity = () => {
      lastActivityAt.value = Date.now()
    }
    const handleFocus = () => {
      focused.value = true
      markActivity()
    }
    const handleBlur = () => {
      focused.value = false
    }

    window.addEventListener('keydown', markActivity, true)
    window.addEventListener('pointermove', markActivity, { capture: true, passive: true })
    window.addEventListener('pointerdown', markActivity, { capture: true, passive: true })
    window.addEventListener('focus', handleFocus)
    window.addEventListener('blur', handleBlur)

    const flush = async () => {
      if (flushing.current || pendingByDay.current.size === 0) return
      flushing.current = true
      const pending = new Map(pendingByDay.current)
      pendingByDay.current.clear()
      try {
        for (const [day, milliseconds] of pending) {
          await addGamificationActivity(day, milliseconds)
        }
      } catch {
        for (const [day, milliseconds] of pending) {
          pendingByDay.current.set(day, (pendingByDay.current.get(day) ?? 0) + milliseconds)
        }
      } finally {
        flushing.current = false
      }
    }

    const ticker = window.setInterval(() => {
      const now = Date.now()
      const active = document.visibilityState === 'visible'
        && focused.value
        && now - lastActivityAt.value <= ACTIVE_IDLE_LIMIT_MS
      if (!active) return
      const day = localDay(new Date(now))
      pendingByDay.current.set(day, (pendingByDay.current.get(day) ?? 0) + TICK_MS)
      setActiveMs((current) => (current ?? 0) + TICK_MS)
      if ([...pendingByDay.current.values()].some((milliseconds) => milliseconds >= FLUSH_MS)) void flush()
    }, TICK_MS)

    const flushOnHide = () => { void flush() }
    document.addEventListener('visibilitychange', flushOnHide)
    window.addEventListener('beforeunload', flushOnHide)
    return () => {
      window.clearInterval(ticker)
      window.removeEventListener('keydown', markActivity, true)
      window.removeEventListener('pointermove', markActivity, true)
      window.removeEventListener('pointerdown', markActivity, true)
      window.removeEventListener('focus', handleFocus)
      window.removeEventListener('blur', handleBlur)
      document.removeEventListener('visibilitychange', flushOnHide)
      window.removeEventListener('beforeunload', flushOnHide)
      void flush()
    }
  }, [])

  const resolvedSnapshot = useMemo(() => {
    if (!snapshot) return null
    const currentActiveMs = activeMs ?? snapshot.activeMsToday
    return {
      ...snapshot,
      activeMsToday: currentActiveMs,
      focusMultiplier: focusMultiplier(currentActiveMs),
    }
  }, [activeMs, snapshot])

  return { snapshot: resolvedSnapshot, xpPulse }
}
