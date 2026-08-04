import type { AppEvent } from './types'

/** Estimation affichée avant un switch : tous les tokens déjà comptabilisés. */
export function estimatedReingestionTokens(events: AppEvent[]): number {
  return events.reduce((total, event) => {
    if (event.type !== 'usage') return total
    return total + event.inputTokens + event.outputTokens
  }, 0)
}
