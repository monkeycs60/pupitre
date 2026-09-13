import { useEffect, useState } from 'react'
import { getCodeConversationCommits } from './api'
import { relativeCodeDate } from './codeFormat'
import type { CodeConversationCommits, CodeConversationRepository } from './types'

const REFRESH_MS = 30_000

interface ConversationWorkspaceCardProps {
  projectId: string
  conversationId: string
  onOpenCode?: (conversationId: string, target: 'conversation' | 'ticket') => void
}

function repositoryName(label: string): string {
  return label.split('/').pop() || label
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count > 1 ? 's' : ''}`
}

function ticketTitle(key: string, commits: number, linked: number): string {
  const detail = linked === 0
    ? 'aucun relié à une conversation'
    : `dont ${linked} relié${linked > 1 ? 's' : ''} à ${linked > 1 ? 'des conversations' : 'une conversation'}`
  return `${key} : ${plural(commits, 'commit')}, ${detail}`
}

function authorsLabel(titles: string[]): string {
  if (titles.length === 0) return 'Chantier du ticket'
  const [first, ...others] = titles
  if (others.length === 0) return `Commité par ${first}`
  const s = others.length > 1 ? 's' : ''
  return `Commité par ${first} et ${others.length} autre${s} conversation${s}`
}

/** Ce que la conversation a commité, dépôt par dépôt ; à défaut, le chantier du ticket qu'elle partage. */
export function ConversationWorkspaceCard({ projectId, conversationId, onOpenCode }: ConversationWorkspaceCardProps) {
  const [data, setData] = useState<CodeConversationCommits | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    const load = () => {
      getCodeConversationCommits(projectId, conversationId, controller.signal).then(setData).catch(() => {})
    }
    load()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') load()
    }, REFRESH_MS)
    return () => {
      controller.abort()
      window.clearInterval(timer)
    }
  }, [projectId, conversationId])

  if (!data) return null
  const ticket = data.ticket
  const own = data.total > 0
  if (!own && !(ticket && (ticket.total > 0 || ticket.branchCommits > 0))) return null

  const repositories = (own ? data.repositories : ticket!.repositories).filter((repository) => repository.commits.length > 0)
  const title = own
    ? `${plural(data.total, 'commit')} sur ${plural(repositories.length, 'dépôt')}`
    : ticketTitle(ticket!.key, Math.max(ticket!.branchCommits, ticket!.total), ticket!.total)
  const detail = own ? 'Chantier de la conversation' : authorsLabel(ticket!.conversations.map((item) => item.title))
  const target = own ? 'conversation' : 'ticket'

  return <article className="code-workspace-card" aria-label={own ? 'Chantier de la conversation' : 'Chantier du ticket'}>
    <div className="code-workspace-card-main">
      <span className={own ? 'code-workspace-card-icon' : 'code-workspace-card-icon is-ticket'} aria-hidden="true">
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><g stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"><circle cx="4.5" cy="3.5" r="1.5" /><circle cx="4.5" cy="12.5" r="1.5" /><circle cx="11.5" cy="5.5" r="1.5" /><path d="M4.5 5v6M11.5 7c0 3-7 2-7 4" /></g></svg>
      </span>
      <span className="code-workspace-card-text">
        <strong>{title}</strong>
        <small>{detail}</small>
      </span>
      {onOpenCode ? <button type="button" className="code-workspace-card-open" onClick={() => onOpenCode(conversationId, target)}>
        {own ? 'Voir dans Code' : 'Voir le chantier'}
      </button> : null}
    </div>
    <ul className="code-workspace-card-repos">
      {repositories.map((repository: CodeConversationRepository, index) => {
        const latest = repository.commits[0]!
        return <li key={repository.repositoryPath}>
          <span className={`code-repo-badge is-repo-${index % 6}`}>{repositoryName(repository.repositoryLabel)}</span>
          <span className="code-filter-count">{repository.commits.length}</span>
          <span className="code-workspace-card-subject" title={latest.subject}>{latest.subject}</span>
          <small>{relativeCodeDate(latest.authoredAt)}</small>
        </li>
      })}
    </ul>
  </article>
}
