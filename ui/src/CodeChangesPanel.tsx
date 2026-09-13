import { useEffect, useState } from 'react'
import { getCodeChanges } from './api'
import { CodeChangedFile } from './CodeChangedFile'
import { codeErrorMessage } from './codeFormat'
import type { CodeBranchChanges, CodeSource } from './types'

interface CodeChangesPanelProps {
  projectId: string
  scopeLabel: string
  sources: CodeSource[]
  prefixes: ReadonlyMap<string, string>
  variant: 'docked' | 'side'
  activeDisplay: string | null
  onOpenDiff: (source: string, path: string) => void
  onOpenFile: (source: string, path: string) => void
  onClose: () => void
}

function rangeLabel(changes: CodeBranchChanges): string {
  if (!changes.base) return 'aucune branche de base trouvée'
  return changes.from?.endsWith('^1') ? `fusionnée dans ${changes.base}` : `depuis ${changes.base}`
}

export function CodeChangesPanel({
  projectId,
  scopeLabel,
  sources,
  prefixes,
  variant,
  activeDisplay,
  onOpenDiff,
  onOpenFile,
  onClose,
}: CodeChangesPanelProps) {
  const [changes, setChanges] = useState<Record<string, { data: CodeBranchChanges | null, error: string | null }>>({})
  const sourceKey = sources.map((source) => source.path).join('\n')

  useEffect(() => {
    const controller = new AbortController()
    for (const path of sourceKey.split('\n').filter(Boolean)) {
      getCodeChanges(projectId, path, controller.signal)
        .then((data) => setChanges((current) => ({ ...current, [path]: { data, error: null } })))
        .catch((reason: unknown) => {
          if (!controller.signal.aborted) setChanges((current) => ({ ...current, [path]: { data: null, error: codeErrorMessage(reason) } }))
        })
    }
    return () => controller.abort()
  }, [projectId, sourceKey])

  const loaded = sources.map((source) => changes[source.path]?.data).filter((data): data is CodeBranchChanges => Boolean(data))
  const files = loaded.flatMap((data) => data.files)
  const added = files.reduce((total, file) => total + (file.added ?? 0), 0)
  const removed = files.reduce((total, file) => total + (file.removed ?? 0), 0)

  return <section className={`code-commit is-${variant}`} aria-label="Diff du chantier">
    <header className="code-commit-header">
      <span className="code-commit-meta">Diff du chantier</span>
      <button type="button" className="code-icon-button" title="Revenir au détail du commit" aria-label="Fermer le diff du chantier" onClick={onClose}>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
      </button>
    </header>
    <h3 className="code-commit-subject">{scopeLabel}</h3>
    <p className="code-changes-summary">
      {files.length} fichier{files.length > 1 ? 's' : ''} sur {sources.length} dépôt{sources.length > 1 ? 's' : ''}
      <span className="code-commit-file-stat"><span className="is-added">+{added}</span><span className="is-removed">−{removed}</span></span>
    </p>
    {sources.map((source, index) => {
      const entry = changes[source.path]
      const prefix = prefixes.get(source.path) ?? ''
      return <div className="code-changes-repo" key={source.path}>
        <p className="code-changes-repo-head">
          {prefix ? <span className={`code-repo-badge is-repo-${index % 6}`}>{prefix}</span> : null}
          <span className="code-changes-range">{entry?.data ? rangeLabel(entry.data) : source.branch ?? ''}</span>
          {entry?.data ? <span className="code-filter-count">{entry.data.files.length}</span> : null}
        </p>
        {!entry ? <div className="code-skeleton" /> : null}
        {entry?.error ? <p className="code-empty-note is-error">{entry.error}</p> : null}
        {entry?.data && entry.data.files.length === 0 ? <p className="code-empty-note">Aucun fichier modifié par la branche.</p> : null}
        {entry?.data && entry.data.files.length > 0 ? <ul className="code-commit-files">
          {entry.data.files.map((file) => {
            const display = prefix ? `${prefix}/${file.path}` : file.path
            return <CodeChangedFile
              key={file.path}
              file={file}
              active={display === activeDisplay}
              diffTitle={`Voir le diff de ${file.path} sur la branche`}
              onOpenDiff={() => onOpenDiff(source.path, file.path)}
              onOpenFile={() => onOpenFile(source.path, file.path)}
            />
          })}
        </ul> : null}
        {entry?.data?.filesTruncated ? <p className="code-truncated-note">Liste tronquée à 500 fichiers.</p> : null}
      </div>
    })}
  </section>
}
