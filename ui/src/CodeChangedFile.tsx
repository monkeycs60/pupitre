import { splitCodePath } from './codeFormat'
import { FileTypeIcon } from './FileTypeIcon'
import type { CodeCommitFile } from './types'

const STATUS_LABELS: Record<string, string> = {
  A: 'ajouté',
  M: 'modifié',
  D: 'supprimé',
  R: 'renommé',
  C: 'copié',
  T: 'type modifié',
}

export function CodeChangedFile({
  file,
  active,
  diffTitle,
  onOpenDiff,
  onOpenFile,
}: {
  file: CodeCommitFile
  active: boolean
  diffTitle: string
  onOpenDiff: () => void
  onOpenFile: () => void
}) {
  const { directory, name } = splitCodePath(file.path)
  return <li className={`code-commit-file${active ? ' is-active' : ''}`}>
    <div className="code-commit-file-main">
      <button
        type="button"
        className="code-commit-file-name"
        aria-current={active ? 'true' : undefined}
        title={diffTitle}
        onClick={onOpenDiff}
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
        title={file.status === 'D' ? 'Fichier supprimé' : 'Ouvrir la version courante du fichier'}
        onClick={onOpenFile}
      >Courant</button>
    </div>
  </li>
}
