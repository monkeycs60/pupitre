import { ExternalLink } from './externalLink'
import type { TicketLinks } from './ticketLinks'

/** Liens ClickUp et MR GitLab d'un ticket, au format icône compact — dans le
 *  header de conversation et sur les groupes de tickets de la sidebar. */
export function TicketLinkIcons({ links, ticketKey }: { links: TicketLinks; ticketKey: string }) {
  return (
    <span className="ticket-link-icons">
      {links.externalUrl !== null ? (
        <ExternalLink
          className="ticket-link-icon"
          href={links.externalUrl}
          ariaLabel={`Ouvrir ${ticketKey} dans ClickUp`}
          title={`Ouvrir ${ticketKey} dans ClickUp`}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path fill="#ff02f0" d="M2.4 8.3 12.1 0l9.5 8.3-3.1 3.5-6.5-5.7-6.6 5.7Z" />
            <path fill="#7b68ee" d="m2 18.4 3.7-2.8c2 2.6 4 3.8 6.4 3.8 2.3 0 4.3-1.2 6.2-3.7l3.7 2.7c-2.7 3.7-6.1 5.6-10 5.6-3.8 0-7.2-1.9-10-5.6Z" />
          </svg>
        </ExternalLink>
      ) : null}
      {links.mergeRequestUrl !== null ? (
        <ExternalLink
          className="ticket-link-icon"
          href={links.mergeRequestUrl}
          ariaLabel={`Ouvrir la MR de ${ticketKey} dans GitLab`}
          title={`Ouvrir la MR de ${ticketKey} dans GitLab`}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path fill="#e24329" d="m12 21.4-3.5-10.7h7Z" />
            <path fill="#fc6d26" d="M12 21.4 8.5 10.7H3.6Zm0 0 3.5-10.7h4.9Z" />
            <path fill="#fca326" d="M3.6 10.7 2.5 14a.8.8 0 0 0 .3.9l9.2 6.6Zm16.8 0 1.1 3.3a.8.8 0 0 1-.3.9L12 21.4Z" />
            <path fill="#e24329" d="M3.6 10.7h4.9L6.4 4.2a.4.4 0 0 0-.7 0Zm16.8 0h-4.9l2.1-6.5a.4.4 0 0 1 .7 0Z" />
          </svg>
        </ExternalLink>
      ) : null}
    </span>
  )
}

/** Lien vers l'issue Sentry d'une conversation ou d'un groupe scout. */
export function SentryLinkIcon({ url, issueKey }: { url: string; issueKey: string }) {
  return (
    <span className="ticket-link-icons">
      <ExternalLink
        className="ticket-link-icon"
        href={url}
        ariaLabel={`Ouvrir ${issueKey} dans Sentry`}
        title={`Ouvrir ${issueKey} dans Sentry`}
      >
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ color: 'var(--sentry-gold)' }}>
          <g stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
            <path d="M7 3.4a1.15 1.15 0 0 1 2 0l4.5 7.8a1.15 1.15 0 0 1-1 1.7H10" />
            <path d="M6.1 6.6a7.5 7.5 0 0 1 3.4 6.3" />
            <path d="M4.6 9.2a4.4 4.4 0 0 1 2 3.7H3.5a1.15 1.15 0 0 1-1-1.7l.6-1.1" />
          </g>
        </svg>
      </ExternalLink>
    </span>
  )
}
