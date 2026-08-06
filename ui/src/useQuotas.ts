import { useEffect, useRef, useState } from 'react'
import { getQuotas, getSettings, updateSettings } from './api'
import { reconnectDelayMs } from './backoff'
import { webSocketUrl } from './transport'
import {
  DEFAULT_QUOTA_THRESHOLDS,
  nextQuotaReevaluationDelay,
  quotaAlerts,
  type QuotaThresholds,
} from './quotaSignals'
import type { QuotaSnapshot, QuotaState } from './types'
import { loadQuotaThresholds } from './quotaSettings'

const EMPTY_SNAPSHOT: QuotaSnapshot = { claude: null, codex: null }

// Clés d'alertes déjà poussées, persistées pour ne pas re-notifier au rechargement.
const NOTIFIED_KEY = 'pupitre.quota-notified'
const NOTIFIED_MAX = 50

function loadNotifiedKeys(): string[] {
  try {
    const raw = localStorage.getItem(NOTIFIED_KEY)
    const parsed: unknown = raw === null ? [] : JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((key) => typeof key === 'string') : []
  } catch {
    return []
  }
}

function persistNotifiedKeys(keys: string[]): void {
  try {
    localStorage.setItem(NOTIFIED_KEY, JSON.stringify(keys.slice(-NOTIFIED_MAX)))
  } catch {
    // Stockage indisponible : on se contente de la dédup en mémoire.
  }
}

export interface Quotas {
  snapshot: QuotaSnapshot
}

/**
 * Quotas des deux providers : snapshot HTTP initial puis flux WS `channel=quotas`
 * (le serveur renvoie l'état courant à l'ouverture, donc la reconnexion se
 * resynchronise seule). Même mécanique de backoff que useConversationEvents.
 */
export function useQuotas(): Quotas {
  const [snapshot, setSnapshot] = useState<QuotaSnapshot>(EMPTY_SNAPSHOT)
  const notifiedRef = useRef<Set<string> | null>(null)

  useEffect(() => {
    let disposed = false
    let socket: WebSocket | null = null
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let alertTimer: ReturnType<typeof setTimeout> | undefined
    let alertScheduleVersion = 0
    let failedAttempts = 0
    let latestSnapshot = EMPTY_SNAPSHOT
    const abortController = new AbortController()

    notifiedRef.current ??= new Set(loadNotifiedKeys())
    const notified = notifiedRef.current
    const thresholds = loadQuotaThresholds(
      () => getSettings(abortController.signal),
      updateSettings,
      localStorage,
    ).catch((error: unknown) => {
      if (!abortController.signal.aborted) {
        console.error('Seuils de quota indisponibles', error)
      }
      return DEFAULT_QUOTA_THRESHOLDS
    })

    function evaluateAndScheduleAlerts() {
      const version = ++alertScheduleVersion
      clearTimeout(alertTimer)
      void thresholds.then((resolved) => {
        if (disposed || version !== alertScheduleVersion) return
        for (const state of Object.values(latestSnapshot)) {
          if (state !== null) void notifyCrossings(state, resolved, notified)
        }
        const delay = nextQuotaReevaluationDelay(latestSnapshot, resolved)
        if (delay !== null) {
          // Une petite marge évite de se réveiller une fraction de ms avant le seuil.
          alertTimer = setTimeout(evaluateAndScheduleAlerts, delay + 50)
        }
      })
    }

    function apply(state: QuotaState) {
      latestSnapshot = { ...latestSnapshot, [state.provider]: state }
      setSnapshot(latestSnapshot)
      evaluateAndScheduleAlerts()
    }

    function connect() {
      const currentSocket = new WebSocket(
        webSocketUrl('/ws?channel=quotas'),
      )
      socket = currentSocket

      function dropAndRetry() {
        if (disposed || socket !== currentSocket) return
        socket = null
        currentSocket.close()
        failedAttempts += 1
        retryTimer = setTimeout(connect, reconnectDelayMs(failedAttempts))
      }

      currentSocket.addEventListener('open', () => {
        if (disposed || socket !== currentSocket) return
        failedAttempts = 0
      })

      currentSocket.addEventListener('message', (message) => {
        if (disposed || socket !== currentSocket) return
        try {
          apply(JSON.parse(String(message.data)) as QuotaState)
        } catch (error) {
          console.error('État de quota illisible', error)
        }
      })

      currentSocket.addEventListener('close', dropAndRetry)
      currentSocket.addEventListener('error', dropAndRetry)
    }

    // Le snapshot HTTP couvre le cas « WS pas encore ouvert » ; l'état renvoyé à
    // l'ouverture du socket l'écrase ensuite (même source, dernier reçu gagne).
    void getQuotas(abortController.signal)
      .then((initial) => {
        if (disposed) return
        for (const state of Object.values(initial)) {
          if (state !== null) apply(state)
        }
      })
      .catch((error: unknown) => {
        if (!abortController.signal.aborted) console.error(error)
      })

    connect()

    return () => {
      disposed = true
      clearTimeout(retryTimer)
      clearTimeout(alertTimer)
      alertScheduleVersion += 1
      abortController.abort()
      socket?.close()
    }
  }, [])

  // L'absence de relevé n'est plus un état global : chaque provider explique
  // lui-même ce qui lui manque (cf. QuotaBar).
  return { snapshot }
}

/**
 * Notification native (API web — la webview Tauri la supporte ; le plugin Tauri
 * notification viendra plus tard). Permission demandée au premier franchissement
 * seulement, pas au démarrage.
 */
async function notifyCrossings(
  state: QuotaState,
  thresholds: QuotaThresholds,
  notified: Set<string>,
): Promise<void> {
  const fresh = quotaAlerts(state, thresholds).filter(
    (alert) => !notified.has(alert.key),
  )
  if (fresh.length === 0) return

  // Marqué avant l'await : deux états reçus coup sur coup ne doublonnent pas.
  for (const alert of fresh) notified.add(alert.key)
  persistNotifiedKeys([...notified])

  if (typeof Notification === 'undefined') return
  let permission = Notification.permission
  if (permission === 'default') {
    try {
      permission = await Notification.requestPermission()
    } catch (error) {
      console.error('Permission de notification refusée', error)
      return
    }
  }
  if (permission !== 'granted') return

  for (const alert of fresh) {
    try {
      new Notification(alert.title, { body: alert.body, tag: alert.key })
    } catch (error) {
      console.error('Notification impossible', error)
    }
  }
}
