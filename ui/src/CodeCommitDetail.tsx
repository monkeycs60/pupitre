import { useEffect, useState } from 'react'
import { getCodeCommit } from './api'
import { absoluteCodeDate, codeErrorMessage, relativeCodeDate, splitCodePath } from './codeFormat'
import { parseCodeRefs } from './codeGraphLayout'
import { ExternalLink } from './externalLink'
import { FileTypeIcon } from './FileTypeIcon'
import { ProviderMark } from './ProviderMark'
import type { TicketLinks } from './ticketLinks'
import type { CodeCommitDetail as CommitDetailData } from './types'

interface CodeCommitDetailProps {
  projectId: string
  sourcePath: string
  sha: string
  repository: { label: string, index: number } | null
  variant: 'docked' | 'side'
  /** Fichier du commit dont le diff est ouvert au centre. */
  activePath: string | null
  ticketForConversation: (conversationId: string) => TicketLinks | null
  onOpenConversation: (conversationId: string) => void
  onOpenDiff: (path: string) => void
  onOpenFile: (path: string) => void
  onSelectCommit: (sha: string) => void
  onClose?: () => void
}

const STATUS_LABELS: Record<string, string> = {
  A: 'ajouté',
  M: 'modifié',
  D: 'supprimé',
  R: 'renommé',
  C: 'copié',
  T: 'type modifié',
}

const BODY_PREVIEW_LINES = 6
const REF_PREVIEW_COUNT = 4

export function CodeCommitDetail({
  projectId,
  sourcePath,
  sha,
  repository,
  variant,
  activePath,
  ticketForConversation,
  onOpenConversation,
  onOpenDiff,
  onOpenFile,
  onSelectCommit,
  onClose,
}: CodeCommitDetailProps) {
  const [loaded, setLoaded] = useState<{ detail: CommitDetailData | null, error: string | null } | null>(null)
  const [bodyOpen, setBodyOpen] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    getCodeCommit(projectId, sourcePath, sha, controller.signal)
      .then((detail) => setLoaded({ detail, error: null }))
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setLoaded({ detail: null, error: codeErrorMessage(reason) })
      })
    return () => controller.abort()
  }, [projectId, sourcePath, sha])

  const closeButton = onClose ? <button type="button" className="code-icon-button" title="Fermer le détail" aria-label="Fermer le détail du commit" onClick={onClose}>
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
  </button> : null
  const repositoryBadge = repository
    ? <span className={`code-repo-badge is-repo-${repository.index % 6}`} title={`Dépôt ${repository.label}`}>{repository.label}</span>
    : null

  if (!loaded || !loaded.detail) {
    return <section className={`code-commit is-${variant}`} aria-label="Détail du commit" aria-busy={!loaded}>
      <header className="code-commit-header">
        <span className="code-commit-sha">{sha.slice(0, 8)}</span>
        {repositoryBadge}
        <span className="code-commit-meta" />
        {closeButton}
      </header>
      {loaded?.error ? <p className="code-empty-note is-error">{loaded.error}</p> : <div className="code-skeleton" />}
    </section>
  }

  const { detail } = loaded
  const refs = parseCodeRefs(detail.refs)
  const bodyLines = detail.body ? detail.body.split('\n') : []
  const clamped = bodyLines.length > BODY_PREVIEW_LINES && !bodyOpen

  return <section className={`code-commit is-${variant}`} aria-label="Détail du commit">
    <header className="code-commit-header">
      <button
        type="button"
        className="code-commit-sha"
        title="Copier le SHA complet"
        onClick={() => void navigator.clipboard?.writeText(detail.sha)}
      >{detail.sha.slice(0, 8)}</button>
      {repositoryBadge}
      <time className="code-commit-meta" dateTime={detail.authoredAt} title={absoluteCodeDate(detail.authoredAt)}>
        {detail.author}, {relativeCodeDate(detail.authoredAt)}
      </time>
      {closeButton}
    </header>

    <h3 className="code-commit-subject">{detail.subject}</h3>
    {refs.length > 0 ? <p className="code-commit-refs">
      {refs.slice(0, REF_PREVIEW_COUNT).map((gitRef) => <span key={gitRef.label} className={`code-ref is-${gitRef.kind}`} title={gitRef.label}>{gitRef.label}</span>)}
      {refs.length > REF_PREVIEW_COUNT
        ? <span className="code-ref is-more" title={refs.slice(REF_PREVIEW_COUNT).map((gitRef) => gitRef.label).join('\n')}>+{refs.length - REF_PREVIEW_COUNT}</span>
        : null}
    </p> : null}

    {bodyLines.length > 0 ? <>
      <pre className={`code-commit-body${clamped ? ' is-clamped' : ''}`}>
        {clamped ? bodyLines.slice(0, BODY_PREVIEW_LINES).join('\n') : detail.body}
      </pre>
      {bodyLines.length > BODY_PREVIEW_LINES ? <button type="button" className="code-text-button" onClick={() => setBodyOpen((value) => !value)}>
        {bodyOpen ? 'Réduire le message' : 'Afficher tout le message'}
      </button> : null}
    </> : null}

    {detail.conversations.map((link) => {
      const ticket = ticketForConversation(link.id)
      return <div className="code-commit-origin" key={link.id}>
        <p className="code-commit-origin-label">Produit par une conversation</p>
        <button type="button" className="code-commit-origin-title" title="Ouvrir la conversation" onClick={() => onOpenConversation(link.id)}>
          <ProviderMark provider={link.provider} />
          <span>{link.title}</span>
        </button>
        {ticket ? <div className="code-commit-origin-actions">
          {ticket.externalUrl
            ? <ExternalLink href={ticket.externalUrl} className="code-chip" title="Ouvrir le ticket">{ticket.ticketKey}</ExternalLink>
            : <span className="code-chip">{ticket.ticketKey}</span>}
          {ticket.mergeRequestUrl
            ? <ExternalLink href={ticket.mergeRequestUrl} className="code-chip is-merge-request" title="Ouvrir la merge request">Merge request</ExternalLink>
            : null}
        </div> : null}
      </div>
    })}

    {detail.conversations.length === 0 && detail.agent ? <div className="code-commit-origin">
      <p className="code-commit-origin-label">Co-écrit par un agent</p>
      <p className="code-commit-agent">
        <ProviderMark provider={detail.agent.provider} />
        <span>{detail.agent.name}</span>
      </p>
    </div> : null}

    {detail.parents.length > 0 ? <p className="code-commit-parents">
      <span>{detail.parents.length > 1 ? 'Parents' : 'Parent'}</span>
      {detail.parents.map((parent) => <button key={parent} type="button" className="code-commit-sha" title="Afficher ce commit" onClick={() => onSelectCommit(parent)}>
        {parent.slice(0, 8)}
      </button>)}
    </p> : null}

    <h4 className="code-commit-files-heading">
      {detail.files.length} fichier{detail.files.length > 1 ? 's' : ''}
      {detail.filesTruncated ? ' (liste tronquée)' : ''}
    </h4>
    <ul className="code-commit-files">
      {detail.files.map((file) => {
        const { directory, name } = splitCodePath(file.path)
        const active = file.path === activePath
        return <li className={`code-commit-file${active ? ' is-active' : ''}`} key={file.path}>
          <div className="code-commit-file-main">
            <button
              type="button"
              className="code-commit-file-name"
              aria-current={active ? 'true' : undefined}
              title={`Voir le diff de ${file.path} dans ce commit`}
              onClick={() => onOpenDiff(file.path)}
            >
              <FileTypeIcon path={file.path} />
              <strong>{name}</strong>
              <span className="code-commit-file-dir">{file.previousPath ? `depuis ${file.previousPath}` : directory}</span>
            </button>
            <span className="code-commit-file-stat" title={STATUS_LABELS[file.status] ?? file.status}>
              {file.added === null ? <span>binaire</span> : <span className="is-added">+{file.added}</span>}
              {file.removed === null ? null : <span className="is-removed">−{file.removed}</span>}
            </span>
            <button
              type="button"
              className="code-text-button"
              disabled={file.status === 'D'}
              title={file.status === 'D' ? 'Fichier supprimé par ce commit' : 'Ouvrir la version courante du fichier'}
              onClick={() => onOpenFile(file.path)}
            >Courant</button>
          </div>
        </li>
      })}
    </ul>
  </section>
}
