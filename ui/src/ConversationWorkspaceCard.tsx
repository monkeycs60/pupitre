import { useEffect, useState } from 'react'
import { getCodeConversationCommits } from './api'
import { relativeCodeDate } from './codeFormat'
import type { CodeConversationCommits } from './types'

const REFRESH_MS = 30_000

interface ConversationWorkspaceCardProps {
  projectId: string
  conversationId: string
  onOpenCode?: (conversationId: string) => void
}

function repositoryName(label: string): string {
  return label.split('/').pop() || label
}

/** Ce que la conversation a commité, dépôt par dépôt, avec un accès direct à l'onglet Code filtré. */
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

  if (!data || data.total === 0) return null
  const repositories = data.repositories.filter((repository) => repository.commits.length > 0)
  return <article className="code-workspace-card" aria-label="Chantier de la conversation">
    <div className="code-workspace-card-main">
      <span className="code-workspace-card-icon" aria-hidden="true">
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><g stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"><circle cx="4.5" cy="3.5" r="1.5" /><circle cx="4.5" cy="12.5" r="1.5" /><circle cx="11.5" cy="5.5" r="1.5" /><path d="M4.5 5v6M11.5 7c0 3-7 2-7 4" /></g></svg>
      </span>
      <span className="code-workspace-card-text">
        <strong>{data.total} commit{data.total > 1 ? 's' : ''} sur {repositories.length} dépôt{repositories.length > 1 ? 's' : ''}</strong>
        <small>Chantier de la conversation</small>
      </span>
      {onOpenCode ? <button type="button" className="code-workspace-card-open" onClick={() => onOpenCode(conversationId)}>Voir dans Code</button> : null}
    </div>
    <ul className="code-workspace-card-repos">
      {repositories.map((repository, index) => {
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
