// Backoff de reconnexion WS : 1s, 2s, puis plafond à 5s.
const RECONNECT_DELAYS_MS = [1000, 2000, 5000]

// `attempt` = numéro de la tentative de reconnexion (1 = première), donc le
// compteur d'échecs consécutifs. Remis à 1 dès qu'une connexion s'ouvre.
export function reconnectDelayMs(attempt: number): number {
  const index = Math.min(
    Math.max(Math.floor(attempt), 1) - 1,
    RECONNECT_DELAYS_MS.length - 1,
  )
  return RECONNECT_DELAYS_MS[index]
}
