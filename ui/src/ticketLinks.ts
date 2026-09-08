import { useEffect, useState } from 'react'
import { getProjectDashboard, getSentryInbox } from './api'
import type { DashboardPayload, SentryInboxPayload, TicketRow } from './types'

/**
 * Liens externes d'un ticket : la fiche ClickUp et les MR GitLab quand le
 * tableau de bord les connaît. Indexés par clé ET par id de ticket, les
 * conversations portant tantôt l'un, tantôt l'autre.
 */
export interface TicketLinks {
  ticketKey: string
  externalUrl: string | null
  mergeRequestUrl: string | null
  branch: string | null
}

/** Ce qu'il faut du tableau de bord pour viser le tableau GitLab plutôt qu'un
 *  dépôt : l'hôte vient de la configuration, le pseudo de la relève. */
export interface GitLabContext {
  host: string | null
  username: string | null
}

function textValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function gitlabContextOf(
  payload: Pick<DashboardPayload, 'integrations' | 'gitlabUsername'>,
): GitLabContext {
  const config = payload.integrations.find((integration) => integration.type === 'gitlab')?.config
  const host = textValue(config?.host)
  return {
    host: host === null ? null : host.replace(/\/+$/, ''),
    username: textValue(payload.gitlabUsername),
  }
}

/**
 * Le travail d'un ticket se répartit entre plusieurs dépôts : la MR relevée
 * par le tableau de bord n'en est qu'une. La recherche du tableau GitLab les
 * rassemble toutes, d'où le lien vers `dashboard/merge_requests` plutôt que
 * vers une MR précise. Sans hôte connu, la MR relevée reste la destination.
 */
export function mergeRequestSearchUrl(ticketKey: string, gitlab: GitLabContext): string | null {
  if (gitlab.host === null) return null
  const query = new URLSearchParams({ scope: 'all', state: 'opened' })
  if (gitlab.username !== null) query.set('assignee_username', gitlab.username)
  query.set('search', /\d+$/.exec(ticketKey)?.[0] ?? ticketKey)
  return `${gitlab.host}/dashboard/merge_requests/search?${query.toString()}`
}

export function ticketLinksOf(ticket: TicketRow, gitlab?: GitLabContext): TicketLinks {
  const mergeRequest = ticket.refs.find((ref) => ref.kind === 'mr')
  const branch = ticket.refs.find((ref) => ref.kind === 'branch')
  const mergeRequestUrl = mergeRequest ? textValue(mergeRequest.payload.url) : null
  return {
    ticketKey: ticket.key,
    externalUrl: ticket.external_url,
    mergeRequestUrl: mergeRequestUrl === null || gitlab === undefined
      ? mergeRequestUrl
      : mergeRequestSearchUrl(ticket.key, gitlab) ?? mergeRequestUrl,
    branch: branch?.ref ?? null,
  }
}

export function ticketLinksIndex(
  payload: Pick<DashboardPayload, 'tickets' | 'integrations' | 'gitlabUsername'>,
): Map<string, TicketLinks> {
  const index = new Map<string, TicketLinks>()
  const gitlab = gitlabContextOf(payload)
  for (const ticket of payload.tickets) {
    const links = ticketLinksOf(ticket, gitlab)
    if (links.externalUrl === null && links.mergeRequestUrl === null && links.branch === null) continue
    index.set(ticket.key, links)
    index.set(ticket.id, links)
  }
  return index
}

/** Permalink Sentry par shortId d'issue — le `origin_key` des conversations. */
export function sentryLinksIndex(payload: Pick<SentryInboxPayload, 'issues'>): Map<string, string> {
  const index = new Map<string, string>()
  for (const issue of payload.issues) {
    const shortId = textValue(issue.payload.shortId) ?? issue.sentry_issue_id
    const permalink = textValue(issue.payload.permalink)
    if (permalink !== null) index.set(shortId, permalink)
  }
  return index
}

const EMPTY_INDEX = new Map<string, TicketLinks>()
const EMPTY_SENTRY_INDEX = new Map<string, string>()

/** L'inbox Sentry se lit aussi en base : un chargement par projet. */
export function useSentryLinks(projectId: string | undefined): Map<string, string> {
  const [index, setIndex] = useState<Map<string, string>>(EMPTY_SENTRY_INDEX)

  useEffect(() => {
    setIndex(EMPTY_SENTRY_INDEX)
    if (projectId === undefined) return
    let ignore = false
    const controller = new AbortController()
    void getSentryInbox(projectId, controller.signal)
      .then((payload) => { if (!ignore) setIndex(sentryLinksIndex(payload)) })
      .catch(() => {
        // Sans intégration Sentry, pas de liens d'issues.
      })
    return () => {
      ignore = true
      controller.abort()
    }
  }, [projectId])

  return index
}

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
