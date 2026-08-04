import type { StoredEvent, SubtaskStatus } from './types'

/**
 * Décisions d'affichage d'une carte de sous-tâche, isolées du composant pour
 * être testables sans DOM.
 *
 * Le problème qu'elles résolvent : une conversation longue accumule des cartes
 * de sous-tâches TERMINÉES. Si chaque carte ouvre son WebSocket au montage, un
 * fil qui a délégué trente fois tient trente sockets — pour des flux qui
 * n'émettront plus jamais rien. La carte commence donc par un snapshot HTTP
 * (`GET /api/subtasks/:id`) et ne s'abonne que si elle a une raison de le
 * faire : elle est dépliée, ou la sous-tâche tourne encore.
 */

/** Dernier `status` du flux, ou null si le flux n'est pas (encore) chargé. */
export function lastStreamStatus(events: StoredEvent[]): SubtaskStatus | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event !== undefined && event.type === 'status') return event.state
  }
  return null
}

/**
 * Statut affiché. `null` = encore inconnu (snapshot en vol) : la carte doit
 * alors afficher un état NEUTRE, surtout pas « en cours » — sinon toute
 * sous-tâche historique repasse en cours à l'ouverture du fil, bouton d'annulation
 * compris, et le compteur de la sidebar annonce des sub-agents fantômes.
 */
export function subtaskStatus(
  events: StoredEvent[],
  snapshot: SubtaskStatus | null,
): SubtaskStatus | null {
  return lastStreamStatus(events) ?? snapshot
}

/**
 * Faut-il tenir un WebSocket ouvert pour cette carte ? Tant que le snapshot
 * n'est pas revenu (`null`), non : c'est lui qui tranche.
 */
export function shouldStreamSubtask(
  isExpanded: boolean,
  snapshot: SubtaskStatus | null,
): boolean {
  return isExpanded || snapshot === 'running'
}

/** Message d'échec du flux, s'il est chargé. */
function lastStreamError(events: StoredEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'status') continue
    return event.state === 'error' ? (event.error ?? null) : null
  }
  return null
}

/**
 * Message d'échec affiché : le flux s'il est là, sinon celui du snapshot (une
 * carte repliée n'est pas abonnée, mais doit quand même dire pourquoi ça a
 * échoué).
 */
export function subtaskFailure(
  status: SubtaskStatus | null,
  events: StoredEvent[],
  snapshotError: string | null,
): string | null {
  if (status !== 'error') return null
  return lastStreamError(events) ?? snapshotError ?? 'Une erreur est survenue.'
}
