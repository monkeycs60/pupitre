import { createContext, Fragment, useContext, useEffect, useMemo, useState } from 'react'
import { createReviewComment, deleteReviewComment, getConversationChanges, listReviewComments, sendReviewComments, updateReviewComment } from './api'
import type { ChangedFileDiff, ConversationChanges, RepositoryChanges, ReviewComment } from './api'
import { reviewMessage } from './reviewMessage'
import { pushToast } from './toasts'
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

interface ReviewDraft {
  repositoryLabel: string
  worktreePath: string
  path: string
  side: 'new' | 'old'
  startLine: number
  endLine: number
  textOf: (side: 'new' | 'old', line: number) => string | undefined
}

interface ReviewState {
  comments: ReviewComment[]
  editing: ReviewDraft | null
  start: (anchor: Omit<ReviewDraft, 'startLine' | 'endLine'> & { line: number }, extend: boolean) => void
  cancel: () => void
  save: (body: string) => Promise<void>
  update: (id: string, body: string) => Promise<void>
  remove: (id: string) => Promise<void>
}

const ReviewContext = createContext<ReviewState | null>(null)

function sameFile(comment: { worktree_path: string, path: string }, worktreePath: string, path: string): boolean {
  return comment.worktree_path === worktreePath && comment.path === path
}

function ReviewForm({ initial = '', onSave, onCancel, label }: { initial?: string, onSave: (body: string) => Promise<void>, onCancel: () => void, label: string }) {
  const [body, setBody] = useState(initial)
  const [saving, setSaving] = useState(false)
  const submit = async () => {
    if (body.trim().length === 0 || saving) return
    setSaving(true)
    try { await onSave(body.trim()) } finally { setSaving(false) }
  }
  return <form className="review-form" onSubmit={(event) => { event.preventDefault(); void submit() }}>
    <textarea
      autoFocus
      value={body}
      placeholder="Ce que l'agent doit changer ici…"
      aria-label={label}
      onChange={(event) => setBody(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel()
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void submit() }
      }}
    />
    <div className="review-form-actions">
      <button type="button" onClick={onCancel}>Annuler</button>
      <button type="submit" className="is-primary" disabled={body.trim().length === 0 || saving}>{initial ? 'Enregistrer' : 'Ajouter à la relecture'}</button>
    </div>
  </form>
}

function ReviewNote({ comment, orphan = false }: { comment: ReviewComment, orphan?: boolean }) {
  const review = useContext(ReviewContext)
  const [editing, setEditing] = useState(false)
  if (review === null) return null
  const lines = comment.start_line === comment.end_line ? `ligne ${comment.start_line}` : `lignes ${comment.start_line}–${comment.end_line}`
  if (editing) {
    return <div className="review-note">
      <ReviewForm initial={comment.body} label={`Modifier le commentaire, ${lines}`} onCancel={() => setEditing(false)} onSave={async (body) => { await review.update(comment.id, body); setEditing(false) }} />
    </div>
  }
  return <div className={`review-note is-${comment.status}`}>
    <div className="review-note-meta">
      <span className="review-note-status">{comment.status === 'draft' ? 'Brouillon' : 'Envoyé'}</span>
      <span>{lines}{orphan ? ' · absente du diff actuel' : ''}</span>
      {comment.status === 'draft' ? <>
        <button type="button" onClick={() => setEditing(true)}>Modifier</button>
        <button type="button" onClick={() => void review.remove(comment.id)}>Supprimer</button>
      </> : null}
    </div>
    <p className="review-note-body">{comment.body}</p>
  </div>
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

function FileDiff({ file, group, collapsed, onToggle, id }: { file: ChangedFileDiff, group: Pick<RepositoryChanges, 'repositoryLabel' | 'worktreePath'>, collapsed: boolean, onToggle: () => void, id: string }) {
  const access = useContext(ToolFileContext)
  const review = useContext(ReviewContext)
  const [bodyRef, onScreen] = useNearScreen<HTMLDivElement>()
  const rows = useMemo(() => (collapsed ? [] : codeDiffRows(file.diff)), [collapsed, file.diff])
  const texts = useMemo(() => rows.map((row) => (isCodeLine(row) ? row.text.slice(1) : row.text)), [rows])
  const [highlighted, setHighlighted] = useState<{ source: string[], lines: string[] } | null>(null)
  const comments = review?.comments.filter((comment) => sameFile(comment, group.worktreePath, file.path)) ?? []
  const editing = review?.editing && review.editing.worktreePath === group.worktreePath && review.editing.path === file.path ? review.editing : null
  const near = onScreen || comments.length > 0 || editing !== null

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
  const textOf = (side: 'new' | 'old', line: number) => {
    const index = rows.findIndex((row) => isCodeLine(row) && (side === 'new' ? row.newLine === line : row.newLine === null && row.oldLine === line))
    return index === -1 ? undefined : texts[index]
  }
  const anchored = new Set<string>()
  const [hovered, setHovered] = useState<{ side: 'new' | 'old', line: number, top: number } | null>(null)
  const hover = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('.changes-diff-line')
    if (!target?.dataset.line) return
    const side = target.dataset.side === 'old' ? 'old' : 'new'
    const line = Number(target.dataset.line)
    if (hovered?.side !== side || hovered.line !== line) setHovered({ side, line, top: target.offsetTop })
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
      {comments.length > 0 ? <span className="changes-file-comments">{comments.length} commentaire{comments.length > 1 ? 's' : ''}</span> : null}
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
      <div
        className="changes-diff"
        role="table"
        aria-label={`Diff de ${file.path}`}
        ref={bodyRef}
        style={near ? undefined : { height: rows.length * ROW_HEIGHT }}
        onMouseOver={review !== null && near ? hover : undefined}
        onMouseLeave={() => setHovered(null)}
      >
        {near && hovered !== null && review !== null ? (
          <button
            type="button"
            className="changes-diff-comment-add"
            style={{ top: hovered.top + 2 }}
            title="Commenter cette ligne · Maj+clic : étendre la plage"
            aria-label={hovered.side === 'old' ? `Commenter la ligne supprimée ${hovered.line}` : `Commenter la ligne ${hovered.line}`}
            onClick={(event) => review.start({ repositoryLabel: group.repositoryLabel, worktreePath: group.worktreePath, path: file.path, side: hovered.side, line: hovered.line, textOf }, event.shiftKey)}
          >+</button>
        ) : null}
        {near ? rows.map((row, index) => {
          if (!isCodeLine(row)) {
            return <div key={index} className="changes-diff-hunk" role="row">{row.text}</div>
          }
          const content = html ? html[index] : escapeHtml(texts[index] ?? '')
          const side = row.newLine !== null ? 'new' as const : 'old' as const
          const line = (row.newLine ?? row.oldLine)!
          const inRange = (start: number, end: number) => line >= start && line <= end
          const reviewed = (editing !== null && editing.side === side && inRange(editing.startLine, editing.endLine))
            || comments.some((comment) => comment.side === side && inRange(comment.start_line, comment.end_line))
          const endingHere = comments.filter((comment) => comment.side === side && comment.end_line === line)
          for (const comment of endingHere) anchored.add(comment.id)
          const formHere = editing !== null && review !== null && editing.side === side && editing.endLine === line
          const lineRow = <div key={index} className={`changes-diff-line is-${row.kind}${reviewed ? ' is-reviewed' : ''}`} role="row" data-side={side} data-line={line}>
            <span className="changes-diff-number">{row.oldLine ?? ''}</span>
            {row.newLine !== null && file.absolutePath !== null && access !== null ? (
              <button type="button" className="changes-diff-number is-link" onClick={() => open(row.newLine)} title={`Ouvrir dans VS Code, ligne ${row.newLine}`}>{row.newLine}</button>
            ) : <span className="changes-diff-number">{row.newLine ?? ''}</span>}
            <span className="changes-diff-sign">{row.kind === 'addition' ? '+' : row.kind === 'deletion' ? '−' : ''}</span>
            <span className="changes-diff-text" dangerouslySetInnerHTML={{ __html: content || ' ' }} />
          </div>
          if (endingHere.length === 0 && !formHere) return lineRow
          return <Fragment key={index}>
            {lineRow}
            {endingHere.map((comment) => <ReviewNote key={comment.id} comment={comment} />)}
            {formHere ? (
              <div className="review-note">
                <ReviewForm
                  label={`Commentaire, ${editing.startLine === editing.endLine ? `ligne ${line}` : `lignes ${editing.startLine}–${editing.endLine}`}`}
                  onCancel={review.cancel}
                  onSave={review.save}
                />
              </div>
            ) : null}
          </Fragment>
        }) : null}
        {near ? comments.filter((comment) => !anchored.has(comment.id)).map((comment) => <ReviewNote key={comment.id} comment={comment} orphan />) : null}
      </div>
    )}
    {!collapsed && file.truncated ? <p className="changes-file-note">Diff tronqué : la suite est visible dans VS Code.</p> : null}
  </section>
}

/** Fichiers d'un diff dépliés à la suite, hors relecture : le diff d'un push, par exemple. */
export function DiffFileList({ files, group, idPrefix }: { files: ChangedFileDiff[], group: Pick<RepositoryChanges, 'repositoryLabel' | 'worktreePath'>, idPrefix: string }) {
  const [toggled, setToggled] = useState<Set<string>>(new Set())
  return <div className="changes-view">
    {files.map((file) => (
      <FileDiff
        key={file.path}
        id={`${idPrefix}-${file.path}`.replace(/[^\w-]/g, '_')}
        file={file}
        group={group}
        collapsed={collapsedByDefault(file) !== toggled.has(file.path)}
        onToggle={() => setToggled((current) => {
          const next = new Set(current)
          if (next.has(file.path)) next.delete(file.path)
          else next.add(file.path)
          return next
        })}
      />
    ))}
  </div>
}

/** Tous les diffs du travail de la conversation à la suite, comme l'onglet « Changes » d'une merge request. */
export function ConversationChangesView({ conversationId, onSendReview }: { conversationId: string, onSendReview?: (message: string) => void }) {
  const [changes, setChanges] = useState<ConversationChanges | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [toggled, setToggled] = useState<Set<string>>(new Set())
  const [comments, setComments] = useState<ReviewComment[]>([])
  const [editing, setEditing] = useState<ReviewDraft | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    listReviewComments(conversationId, controller.signal).then((list) => setComments(Array.isArray(list) ? list : [])).catch(() => {})
    return () => controller.abort()
  }, [conversationId])

  const failed = (title: string) => (reason: unknown) => {
    pushToast({ tone: 'danger', title, detail: reason instanceof Error ? reason.message : String(reason) })
  }
  const review: ReviewState = {
    comments,
    editing,
    start: (anchor, extend) => {
      const { line, ...rest } = anchor
      setEditing((current) => extend && current && current.worktreePath === rest.worktreePath && current.path === rest.path && current.side === rest.side
        ? { ...current, startLine: Math.min(current.startLine, line), endLine: Math.max(current.endLine, line) }
        : { ...rest, startLine: line, endLine: line })
    },
    cancel: () => setEditing(null),
    save: async (body) => {
      if (editing === null) return
      const lines: string[] = []
      for (let line = editing.startLine; line <= editing.endLine; line += 1) {
        const text = editing.textOf(editing.side, line)
        if (text !== undefined) lines.push(text)
      }
      try {
        const created = await createReviewComment(conversationId, {
          repositoryLabel: editing.repositoryLabel,
          worktreePath: editing.worktreePath,
          path: editing.path,
          side: editing.side,
          startLine: editing.startLine,
          endLine: editing.endLine,
          lineText: lines.join('\n'),
          body,
        })
        setComments((current) => [...current, created])
        setEditing(null)
      } catch (reason) { failed('Commentaire non enregistré')(reason) }
    },
    update: async (id, body) => {
      try {
        const updated = await updateReviewComment(conversationId, id, body)
        setComments((current) => current.map((comment) => (comment.id === id ? updated : comment)))
      } catch (reason) { failed('Commentaire non modifié')(reason) }
    },
    remove: async (id) => {
      try {
        await deleteReviewComment(conversationId, id)
        setComments((current) => current.filter((comment) => comment.id !== id))
      } catch (reason) { failed('Commentaire non supprimé')(reason) }
    },
  }
  const drafts = comments.filter((comment) => comment.status === 'draft')
  const sendReview = async () => {
    if (!onSendReview || drafts.length === 0) return
    onSendReview(reviewMessage(drafts))
    try {
      const sent = new Set((await sendReviewComments(conversationId)).map((comment) => comment.id))
      setComments((current) => current.map((comment) => (sent.has(comment.id) ? { ...comment, status: 'sent' } : comment)))
      pushToast({ tone: 'ok', title: 'Relecture ajoutée au message', detail: `${drafts.length} commentaire${drafts.length > 1 ? 's' : ''} dans le composer, prêt${drafts.length > 1 ? 's' : ''} à envoyer` })
    } catch (reason) { failed('Relecture non marquée comme envoyée')(reason) }
  }

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

  return <ReviewContext.Provider value={review}><div className="changes-view">
    {comments.length > 0 ? (
      <div className="review-bar">
        <span>Relecture : {drafts.length} brouillon{drafts.length > 1 ? 's' : ''}{comments.length > drafts.length ? ` · ${comments.length - drafts.length} envoyé${comments.length - drafts.length > 1 ? 's' : ''}` : ''}</span>
        {onSendReview ? (
          <button type="button" disabled={drafts.length === 0} onClick={() => void sendReview()} title="Déposer les commentaires dans le composer, sous forme de consigne pour l'agent">
            Envoyer la relecture
          </button>
        ) : null}
      </div>
    ) : null}
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
          return <FileDiff key={key} id={anchor(key)} file={file} group={group} collapsed={isCollapsed(key, file)} onToggle={() => toggle(key)} />
        })}
      </div>
    ))}
  </div></ReviewContext.Provider>
}
