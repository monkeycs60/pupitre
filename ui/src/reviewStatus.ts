import type { ReviewStatusSnapshot } from './types'

/** Un scan tourne seulement si un statut est connu ET porte un run. */
export function isScanRunning(status: ReviewStatusSnapshot | null | undefined): boolean {
  return status?.running != null
}
