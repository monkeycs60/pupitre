import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { addPresenceSlice, getTimeSnapshot } from './api'
import type { TimeMode, TimeSnapshot } from './types'

/**
 * Sans signal d'activité pendant ce délai, on cesse de compter. Deux minutes
 * ne tiennent que parce que la molette et le défilement comptent : lire une
 * réponse longue sans toucher à la souris reste du travail.
 */
const IDLE_LIMIT_MS = 2 * 60_000
const TICK_MS = 1_000
/** Le tick d'une seconde reste interne (refs) : publié tel quel dans le state,
 *  il re-rendait tout l'arbre depuis App chaque seconde. Les affichages
 *  (niveau, barre de progression, compteur du jour) se contentent de la minute. */
const PUBLISH_MS = 60_000
const FLUSH_MS = 15_000
const POLL_MS = 30_000
/** Au-delà, deux ticks appartiennent à deux moments différents. */
const TICK_GAP_MS = 3_000
/** Le sidecar refuse plus long ; on coupe avant d'y arriver. */
const MAX_SLICE_MS = 25 * 60_000

interface OpenSlice {
  projectId: string
  conversationId: string | null
  startMs: number
  lastTickMs: number
}

function modeKey(projectId: string | null): string {
  return `pupitre:time-mode:${projectId ?? 'global'}`
}

function readMode(projectId: string | null): TimeMode {
  try {
    return window.localStorage.getItem(modeKey(projectId)) === 'agent' ? 'agent' : 'user'
  } catch {
    return 'user'
  }
}

export interface TimeTracking {
  snapshot: TimeSnapshot | null
  mode: TimeMode
  toggleMode: () => void
}

/**
 * Mesure le temps humain passé sur le projet sélectionné et lit le compteur
 * agent en parallèle. La bascule entre les deux est un choix d'affichage,
 * mémorisé par projet dans le navigateur : ce n'est pas une donnée de projet.
 */
export function useTimeTracking(
  projectId: string | null,
  conversationId: string | null,
): TimeTracking {
  const [snapshot, setSnapshot] = useState<TimeSnapshot | null>(null)
  const [pendingMs, setPendingMs] = useState(0)
  const [mode, setMode] = useState<TimeMode>(() => readMode(projectId))

  const pending = useRef(0)
  const published = useRef(0)
  const open = useRef<OpenSlice | null>(null)
  const queue = useRef<Array<{ projectId: string; conversationId: string | null; startedAt: string; endedAt: string }>>([])
  const flushing = useRef(false)
  const target = useRef({ projectId, conversationId })
  target.current = { projectId, conversationId }

  useEffect(() => { setMode(readMode(projectId)) }, [projectId])

  const toggleMode = useCallback(() => {
    setMode((current) => {
      const next: TimeMode = current === 'user' ? 'agent' : 'user'
      try {
        window.localStorage.setItem(modeKey(target.current.projectId), next)
      } catch {
        // Une préférence d'affichage ne doit jamais casser la barre latérale.
      }
      return next
    })
  }, [])

  useEffect(() => {
    let disposed = false
    async function load() {
      const startedAt = Date.now()
      try {
        const next = await getTimeSnapshot(
          target.current.projectId ?? undefined,
          target.current.conversationId ?? undefined,
        )
        if (disposed) return
        setSnapshot(next)
        // Seuls les ticks postérieurs au départ de la requête restent à
        // ajouter : les précédents sont déjà dans la réponse ou le seront.
        pending.current = Math.max(0, Math.min(pending.current, Date.now() - startedAt))
        published.current = pending.current
        setPendingMs(pending.current)
      } catch {
        // Le suivi du temps est une lecture de confort : jamais bloquant.
      }
    }
    void load()
    const poll = window.setInterval(() => { void load() }, POLL_MS)
    const onTurnComplete = () => { void load() }
    window.addEventListener('pupitre:turn-complete', onTurnComplete)
    return () => {
      disposed = true
      window.clearInterval(poll)
      window.removeEventListener('pupitre:turn-complete', onTurnComplete)
    }
  }, [projectId, conversationId])

  useEffect(() => {
    const lastActivityAt = { value: Date.now() }
    const focused = { value: document.hasFocus() }
    const markActivity = () => { lastActivityAt.value = Date.now() }
    const handleFocus = () => { focused.value = true; markActivity() }
    const handleBlur = () => { focused.value = false }

    window.addEventListener('keydown', markActivity, true)
    window.addEventListener('pointermove', markActivity, { capture: true, passive: true })
    window.addEventListener('pointerdown', markActivity, { capture: true, passive: true })
    window.addEventListener('wheel', markActivity, { capture: true, passive: true })
    window.addEventListener('scroll', markActivity, { capture: true, passive: true })
    window.addEventListener('focus', handleFocus)
    window.addEventListener('blur', handleBlur)

    const close = () => {
      const slice = open.current
      open.current = null
      if (!slice || slice.lastTickMs <= slice.startMs) return
      queue.current.push({
        projectId: slice.projectId,
        conversationId: slice.conversationId,
        startedAt: new Date(slice.startMs).toISOString(),
        endedAt: new Date(slice.lastTickMs).toISOString(),
      })
    }

    const flush = async () => {
      close()
      if (flushing.current || queue.current.length === 0) return
      flushing.current = true
      const batch = queue.current
      queue.current = []
      try {
        for (const slice of batch) await addPresenceSlice(slice)
      } catch {
        queue.current.unshift(...batch)
      } finally {
        flushing.current = false
      }
    }

    const ticker = window.setInterval(() => {
      const now = Date.now()
      const { projectId: currentProject, conversationId: currentConversation } = target.current
      const active = currentProject !== null
        && document.visibilityState === 'visible'
        && focused.value
        && now - lastActivityAt.value <= IDLE_LIMIT_MS
      if (!active) {
        close()
        return
      }
      const slice = open.current
      const continues = slice !== null
        && slice.projectId === currentProject
        && slice.conversationId === currentConversation
        && now - slice.lastTickMs <= TICK_GAP_MS
        && now - slice.startMs <= MAX_SLICE_MS
      if (continues) slice.lastTickMs = now
      else {
        close()
        open.current = {
          projectId: currentProject,
          conversationId: currentConversation,
          startMs: now - TICK_MS,
          lastTickMs: now,
        }
      }
      pending.current += TICK_MS
      if (pending.current - published.current >= PUBLISH_MS) {
        published.current = pending.current
        setPendingMs(pending.current)
      }
      const openedFor = open.current ? now - open.current.startMs : 0
      if (openedFor >= FLUSH_MS) void flush()
    }, TICK_MS)

    const flushNow = () => { void flush() }
    document.addEventListener('visibilitychange', flushNow)
    window.addEventListener('beforeunload', flushNow)
    return () => {
      window.clearInterval(ticker)
      window.removeEventListener('keydown', markActivity, true)
      window.removeEventListener('pointermove', markActivity, true)
      window.removeEventListener('pointerdown', markActivity, true)
      window.removeEventListener('wheel', markActivity, true)
      window.removeEventListener('scroll', markActivity, true)
      window.removeEventListener('focus', handleFocus)
      window.removeEventListener('blur', handleBlur)
      document.removeEventListener('visibilitychange', flushNow)
      window.removeEventListener('beforeunload', flushNow)
      void flush()
    }
  }, [])

  const resolved = useMemo(() => {
    if (!snapshot) return null
    if (pendingMs <= 0) return snapshot
    const ms = snapshot.user.ms + pendingMs
    return {
      ...snapshot,
      user: {
        ms,
        level: Math.floor(ms / 3_600_000),
        levelMs: ms % 3_600_000,
        progress: (ms % 3_600_000) / 3_600_000,
        todayMs: snapshot.user.todayMs + pendingMs,
      },
    }
  }, [pendingMs, snapshot])

  return { snapshot: resolved, mode, toggleMode }
}
