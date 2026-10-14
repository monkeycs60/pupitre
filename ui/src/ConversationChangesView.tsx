import { useContext, useEffect, useMemo, useState } from 'react'
import { getConversationChanges } from './api'
import type { ChangedFileDiff, ConversationChanges, RepositoryChanges } from './api'
import { escapeHtml, highlightCode } from './codeHighlight'
import { FileTypeIcon } from './FileTypeIcon'
import { ToolFileContext } from './toolFiles'
import { codeDiffRows, isCodeLine } from './unifiedDiff'
import './styles/conversation-changes.css'

const COLLAPSED_ABOVE_LINES = 400
const HIGHLIGHT_BELOW_ROWS = 2_000
const ROW_HEIGHT = 20
const RENDER_MARGIN_PX = 1_500
const STATUS_LABELS: Record<ChangedFileDiff['status'], string> = { added: 'A', deleted: 'D', renamed: 'R', modified: 'M' }
const STATUS_TITLES: Record<ChangedFileDiff['status'], string> = { added: 'Ajouté', deleted: 'Supprimé', renamed: 'Renommé', modified: 'Modifié' }

function fileKey(groupIndex: number, file: ChangedFileDiff): string {
  return `${groupIndex}:${file.path}`
}

function collapsedByDefault(file: ChangedFileDiff): boolean {
  return file.generated || file.binary || file.added + file.removed > COLLAPSED_ABOVE_LINES
}

function groupTitle(group: RepositoryChanges): string {
  if (group.kind === 'uncommitted') return 'Non commité'
  if (group.title) return group.title
  return `${group.commits} commit${group.commits > 1 ? 's' : ''}`
}

function scrollParent(element: HTMLElement): HTMLElement | null {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(parent).overflowY)) return parent
  }
  return null
}

/**
 * Vrai quand l'élément est à moins de RENDER_MARGIN_PX de la zone visible de
 * son conteneur défilant. WebKitGTK saccade dès que des milliers de lignes de
 * diff sont mises en page à la fois, même hors de l'écran.
 */
function useNearScreen<T extends HTMLElement>(): [(element: T | null) => void, boolean] {
  const [element, setElement] = useState<T | null>(null)
  const [near, setNear] = useState(typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    if (!element || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      ([entry]) => setNear(entry?.isIntersecting ?? false),
      { root: scrollParent(element), rootMargin: `${RENDER_MARGIN_PX}px 0px` },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])
  return [setElement, near]
}

function FileDiff({ file, collapsed, onToggle, id }: { file: ChangedFileDiff, collapsed: boolean, onToggle: () => void, id: string }) {
  const access = useContext(ToolFileContext)
  const [bodyRef, near] = useNearScreen<HTMLDivElement>()
  const rows = useMemo(() => (collapsed ? [] : codeDiffRows(file.diff)), [collapsed, file.diff])
  const texts = useMemo(() => rows.map((row) => (isCodeLine(row) ? row.text.slice(1) : row.text)), [rows])
  const [highlighted, setHighlighted] = useState<{ source: string[], lines: string[] } | null>(null)

  useEffect(() => {
    if (collapsed || !near || texts.length === 0 || texts.length > HIGHLIGHT_BELOW_ROWS) return
    let cancelled = false
    highlightCode(`${texts.join('\n')}\n`, file.path)
      .then((lines) => { if (!cancelled) setHighlighted({ source: texts, lines }) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [collapsed, near, texts, file.path])

  const html = highlighted?.source === texts && highlighted.lines.length === texts.length ? highlighted.lines : null
  const open = (line: number | null) => {
    if (access !== null && file.absolutePath !== null) void access.openInEditor([{ path: file.absolutePath, line }])
  }

  return <section className="changes-file" id={id}>
    <header className="changes-file-header">
      <button type="button" className="changes-file-toggle" onClick={onToggle} aria-expanded={!collapsed} title={collapsed ? 'Afficher le diff' : 'Replier le diff'}>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d={collapsed ? 'm6 4 4 4-4 4' : 'm4 6 4 4 4-4'} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      <span className={`changes-file-status is-${file.status}`} title={STATUS_TITLES[file.status]}>{STATUS_LABELS[file.status]}</span>
      <FileTypeIcon path={file.path} />
      <span className="changes-file-path" title={file.path}>
        {file.previousPath ? <><span className="changes-file-previous">{file.previousPath}</span> → </> : null}
        {file.path}
      </span>
      <span className="changes-file-stats"><span className="is-added">+{file.added}</span> <span className="is-removed">−{file.removed}</span></span>
      {file.absolutePath !== null && access !== null ? (
        <button type="button" className="changes-file-open" onClick={() => open(file.firstLine)} title={`Ouvrir dans VS Code${file.firstLine ? `, ligne ${file.firstLine}` : ''}`}>
          VS Code
        </button>
      ) : null}
    </header>
    {collapsed ? null : file.binary ? (
      <p className="changes-file-note">Fichier binaire : pas de diff texte.</p>
    ) : (
      <div className="changes-diff" role="table" aria-label={`Diff de ${file.path}`} ref={bodyRef} style={near ? undefined : { height: rows.length * ROW_HEIGHT }}>
        {near ? rows.map((row, index) => {
          if (!isCodeLine(row)) {
            return <div key={index} className="changes-diff-hunk" role="row">{row.text}</div>
          }
          const content = html ? html[index] : escapeHtml(texts[index] ?? '')
          return <div key={index} className={`changes-diff-line is-${row.kind}`} role="row">
            <span className="changes-diff-number">{row.oldLine ?? ''}</span>
            {row.newLine !== null && file.absolutePath !== null && access !== null ? (
              <button type="button" className="changes-diff-number is-link" onClick={() => open(row.newLine)} title={`Ouvrir dans VS Code, ligne ${row.newLine}`}>{row.newLine}</button>
            ) : <span className="changes-diff-number">{row.newLine ?? ''}</span>}
            <span className="changes-diff-sign">{row.kind === 'addition' ? '+' : row.kind === 'deletion' ? '−' : ''}</span>
            <span className="changes-diff-text" dangerouslySetInnerHTML={{ __html: content || ' ' }} />
          </div>
        }) : null}
      </div>
    )}
    {!collapsed && file.truncated ? <p className="changes-file-note">Diff tronqué : la suite est visible dans VS Code.</p> : null}
  </section>
}

/** Tous les diffs du travail de la conversation à la suite, comme l'onglet « Changes » d'une merge request. */
export function ConversationChangesView({ conversationId }: { conversationId: string }) {
  const [changes, setChanges] = useState<ConversationChanges | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [toggled, setToggled] = useState<Set<string>>(new Set())

  useEffect(() => {
    const controller = new AbortController()
    getConversationChanges(conversationId, controller.signal)
      .then(setChanges)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason))
      })
    return () => controller.abort()
  }, [conversationId])

  if (error !== null) return <p className="changes-empty">Changements indisponibles : {error}</p>
  if (changes === null) return <p className="changes-empty">Chargement des changements…</p>
  const files = changes.repositories.flatMap((group, groupIndex) => group.files.map((file) => ({ group, groupIndex, file })))
  if (files.length === 0) return <p className="changes-empty">Aucun changement à afficher.</p>

  const added = files.reduce((total, entry) => total + entry.file.added, 0)
  const removed = files.reduce((total, entry) => total + entry.file.removed, 0)
  const isCollapsed = (key: string, file: ChangedFileDiff) => collapsedByDefault(file) !== toggled.has(key)
  const toggle = (key: string) => setToggled((current) => {
    const next = new Set(current)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })
  const anchor = (key: string) => `changes-${conversationId}-${key}`.replace(/[^\w-]/g, '_')

  return <div className="changes-view">
    <div className="changes-summary">
      <strong>{files.length} fichier{files.length > 1 ? 's' : ''} modifié{files.length > 1 ? 's' : ''}</strong>
      <span className="is-added">+{added}</span>
      <span className="is-removed">−{removed}</span>
      {changes.truncated ? <span className="changes-truncated">Liste tronquée : diff trop volumineux</span> : null}
    </div>
    {files.length > 3 ? (
      <ol className="changes-index">
        {files.map(({ groupIndex, file }) => {
          const key = fileKey(groupIndex, file)
          return <li key={key}>
            <a href={`#${anchor(key)}`} onClick={(event) => {
              event.preventDefault()
              document.getElementById(anchor(key))?.scrollIntoView({ block: 'start', behavior: 'smooth' })
            }}>
              <span className={`changes-file-status is-${file.status}`}>{STATUS_LABELS[file.status]}</span>
              <span className="changes-index-path">{file.path}</span>
              <span className="is-added">+{file.added}</span>
              <span className="is-removed">−{file.removed}</span>
            </a>
          </li>
        })}
      </ol>
    ) : null}
    {changes.repositories.map((group, groupIndex) => (
      <div key={`${group.worktreePath}:${group.kind}:${group.title ?? ''}`} className="changes-group">
        <h4 className="changes-group-title">
          <span className="changes-group-repository">{group.repositoryLabel}</span>
          {group.branch ? <span className="changes-group-branch">{group.branch}</span> : null}
          <span className="changes-group-scope">{groupTitle(group)}</span>
        </h4>
        {group.files.map((file) => {
          const key = fileKey(groupIndex, file)
          return <FileDiff key={key} id={anchor(key)} file={file} collapsed={isCollapsed(key, file)} onToggle={() => toggle(key)} />
        })}
      </div>
    ))}
  </div>
}
