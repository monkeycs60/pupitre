import { useEffect, useState } from 'react'
import { getProjectDashboard } from './api'
import type { DashboardPayload, TicketRow } from './types'

/**
 * Liens externes d'un ticket : la fiche ClickUp et la MR GitLab quand le
 * tableau de bord les connaît. Indexés par clé ET par id de ticket, les
 * conversations portant tantôt l'un, tantôt l'autre.
 */
export interface TicketLinks {
  ticketKey: string
  externalUrl: string | null
  mergeRequestUrl: string | null
}

function textValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function ticketLinksOf(ticket: TicketRow): TicketLinks {
  const mergeRequest = ticket.refs.find((ref) => ref.kind === 'mr')
  return {
    ticketKey: ticket.key,
    externalUrl: ticket.external_url,
    mergeRequestUrl: mergeRequest ? textValue(mergeRequest.payload.url) : null,
  }
}

export function ticketLinksIndex(payload: Pick<DashboardPayload, 'tickets'>): Map<string, TicketLinks> {
  const index = new Map<string, TicketLinks>()
  for (const ticket of payload.tickets) {
    const links = ticketLinksOf(ticket)
    if (links.externalUrl === null && links.mergeRequestUrl === null) continue
    index.set(ticket.key, links)
    index.set(ticket.id, links)
  }
  return index
}

const EMPTY_INDEX = new Map<string, TicketLinks>()

/** Le tableau de bord se lit en base côté sidecar : l'appel est bon marché,
 *  un chargement par projet suffit. */
export function useTicketLinks(projectId: string | undefined): Map<string, TicketLinks> {
  const [index, setIndex] = useState<Map<string, TicketLinks>>(EMPTY_INDEX)

  useEffect(() => {
    setIndex(EMPTY_INDEX)
    if (projectId === undefined) return
    let ignore = false
    const controller = new AbortController()
    void getProjectDashboard(projectId, controller.signal)
      .then((payload) => { if (!ignore) setIndex(ticketLinksIndex(payload)) })
      .catch(() => {
        // Sans tableau de bord (intégrations non configurées), pas de liens.
      })
    return () => {
      ignore = true
      controller.abort()
    }
  }, [projectId])

  return index
}
