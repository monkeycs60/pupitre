import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { getCodeBlame, getCodeFile, getCodeHistory } from './api'
import { absoluteCodeDate, codeErrorMessage, DIRTY_LABELS, relativeCodeDate, splitCodePath } from './codeFormat'
import { highlightCode, plainCodeLines } from './codeHighlight'
import { FileTypeIcon } from './FileTypeIcon'
import { ProviderMark } from './ProviderMark'
import { useVirtualWindow } from './useVirtualWindow'
import type { CodeBlame, CodeBlameGroup, CodeCommitSummary, CodeDirtyStatus, CodeFile } from './types'

export type CodeReaderMode = 'code' | 'blame' | 'history'

export interface CodeOpenFile {
  path: string
  line: number | null
  nonce: number
}

const LINE_HEIGHT = 20

const MODES: ReadonlyArray<{ id: CodeReaderMode, label: string }> = [
  { id: 'code', label: 'Code' },
  { id: 'blame', label: 'Blame' },
  { id: 'history', label: 'Historique' },
]

interface Keyed<T> {
  key: string
  value: T | null
  error: string | null
}

interface CodeReaderProps {
  projectId: string
  sourcePath: string | null
  openFile: CodeOpenFile | null
  mode: CodeReaderMode
  dirty: ReadonlyMap<string, CodeDirtyStatus>
  selectedSha: string | null
  active: boolean
  onModeChange: (mode: CodeReaderMode) => void
  onSelectCommit: (sha: string) => void
  onOpenFile: (path: string) => void
  onOpenConversation: (conversationId: string) => void
}

function statusClass(status: CodeDirtyStatus): string {
  return status === '?' ? 'untracked' : status.toLowerCase()
}

function BlameCell({
  group,
  offset,
  selected,
  onSelect,
  onOpenConversation,
}: {
  group: CodeBlameGroup | undefined
  offset: number
  selected: boolean
  onSelect: (sha: string) => void
  onOpenConversation: (conversationId: string) => void
}) {
  if (!group) return <span className="code-blame-cell" />
  const linked = group.conversations[0]
  const className = [
    'code-blame-cell',
    offset === 0 ? 'is-group-start' : '',
    linked ? `is-provider-${linked.provider}` : '',
    group.uncommitted ? 'is-uncommitted' : '',
    selected ? 'is-selected' : '',
  ].filter(Boolean).join(' ')

  let content = null
  if (offset === 0) {
    content = group.uncommitted
      ? <span className="code-blame-author">Non commité</span>
      : <>
        {linked ? <ProviderMark provider={linked.provider} /> : null}
        <span className="code-blame-author">{group.author}</span>
        <span className="code-blame-date" title={absoluteCodeDate(group.authoredAt)}>{relativeCodeDate(group.authoredAt)}</span>
      </>
  } else if (offset === 1 && !group.uncommitted) {
    content = <span className="code-blame-summary">{group.summary}</span>
  } else if (offset === 2 && linked) {
    content = <button
      type="button"
      className="code-conversation-chip"
      title={`Ouvrir « ${linked.title} »`}
      onClick={(event) => {
        event.stopPropagation()
        onOpenConversation(linked.id)
      }}
    >
      <ProviderMark provider={linked.provider} />
      <span>{linked.title}</span>
    </button>
  }

  if (group.uncommitted) return <span className={className}>{content}</span>
  return <span
    className={className}
    role="button"
    tabIndex={offset === 0 ? 0 : -1}
    title={`${group.summary} (${group.sha.slice(0, 8)})`}
    onClick={() => onSelect(group.sha)}
    onKeyDown={(event: KeyboardEvent<HTMLSpanElement>) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        onSelect(group.sha)
      }
    }}
  >{content}</span>
}

export function CodeReader({
  projectId,
  sourcePath,
  openFile,
  mode,
  dirty,
  selectedSha,
  active,
  onModeChange,
  onSelectCommit,
  onOpenFile,
  onOpenConversation,
}: CodeReaderProps) {
  const path = openFile?.path ?? null
  const nonce = openFile?.nonce ?? 0
  const key = sourcePath && path ? `${sourcePath}\n${path}` : null
  const [file, setFile] = useState<Keyed<CodeFile> | null>(null)
  const [blame, setBlame] = useState<Keyed<CodeBlame> | null>(null)
  const [history, setHistory] = useState<Keyed<CodeCommitSummary[]> | null>(null)
  const [highlighted, setHighlighted] = useState<{ content: string, lines: string[] } | null>(null)

  useEffect(() => {
    if (!sourcePath || !path) return
    const requestKey = `${sourcePath}\n${path}`
    const controller = new AbortController()
    getCodeFile(projectId, sourcePath, path, controller.signal)
      .then((value) => setFile({ key: requestKey, value, error: null }))
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setFile({ key: requestKey, value: null, error: codeErrorMessage(reason) })
      })
    return () => controller.abort()
  }, [projectId, sourcePath, path, nonce])

  useEffect(() => {
    if (mode !== 'blame' || !sourcePath || !path) return
    const requestKey = `${sourcePath}\n${path}`
    const controller = new AbortController()
    getCodeBlame(projectId, sourcePath, path, controller.signal)
      .then((value) => setBlame({ key: requestKey, value, error: null }))
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setBlame({ key: requestKey, value: null, error: codeErrorMessage(reason) })
      })
    return () => controller.abort()
  }, [mode, projectId, sourcePath, path, nonce])

  useEffect(() => {
    if (mode !== 'history' || !sourcePath || !path) return
    const requestKey = `${sourcePath}\n${path}`
    const controller = new AbortController()
    getCodeHistory(projectId, sourcePath, path, controller.signal)
      .then((value) => setHistory({ key: requestKey, value, error: null }))
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setHistory({ key: requestKey, value: null, error: codeErrorMessage(reason) })
      })
    return () => controller.abort()
  }, [mode, projectId, sourcePath, path, nonce])

  const currentFile = file?.key === key ? file : null
  const content = currentFile?.value?.content ?? null
  const plain = useMemo(() => (content === null ? [] : plainCodeLines(content)), [content])

  useEffect(() => {
    if (content === null || !path) return
    let cancelled = false
    highlightCode(content, path)
      .then((lines) => {
        if (!cancelled) setHighlighted({ content, lines })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [content, path])

  const lines = highlighted?.content === content && highlighted.lines.length === plain.length ? highlighted.lines : plain
  const currentBlame = mode === 'blame' && blame?.key === key ? blame : null
  const blameByLine = useMemo(() => {
    const byLine: Array<{ group: CodeBlameGroup, offset: number } | undefined> = []
    for (const group of currentBlame?.value?.groups ?? []) {
      for (let offset = 0; offset < group.count; offset += 1) byLine[group.start - 1 + offset] = { group, offset }
    }
    return byLine
  }, [currentBlame])

  const lineWindow = useVirtualWindow<HTMLDivElement>(lines.length, LINE_HEIGHT)
  const { scrollToIndex, element: scrollElement, elementRef: scrollRef } = lineWindow
  const handledNonce = useRef<number | null>(null)
  const savedScroll = useRef(0)

  useEffect(() => {
    if (!openFile || lines.length === 0 || !scrollElement || handledNonce.current === openFile.nonce) return
    handledNonce.current = openFile.nonce
    if (openFile.line) scrollToIndex(openFile.line - 1, 'center')
    else scrollElement.scrollTop = 0
  }, [openFile, lines.length, scrollToIndex, scrollElement])

  useEffect(() => {
    if (!scrollElement) return
    const save = () => {
      if (scrollElement.clientHeight > 0) savedScroll.current = scrollElement.scrollTop
    }
    scrollElement.addEventListener('scroll', save, { passive: true })
    return () => scrollElement.removeEventListener('scroll', save)
  }, [scrollElement])

  useLayoutEffect(() => {
    if (active && scrollRef.current) scrollRef.current.scrollTop = savedScroll.current
  }, [active, scrollRef])

  const status = path ? dirty.get(path) : undefined
  const { directory, name } = splitCodePath(path ?? '')
  const dirtyFiles = [...dirty.entries()].filter(([, value]) => value !== 'D')

  function renderBody() {
    if (!path) {
      return <div className="code-reader-empty">
        <h3>Aucun fichier ouvert</h3>
        <p>Parcours l’arborescence, ou ouvre un fichier par son nom avec <kbd>Ctrl</kbd> <kbd>P</kbd>.</p>
        {dirtyFiles.length > 0 ? <section>
          <h4>Modifiés dans cet état du code</h4>
          <ul>
            {dirtyFiles.slice(0, 12).map(([dirtyPath, dirtyStatus]) => <li key={dirtyPath}>
              <button type="button" onClick={() => onOpenFile(dirtyPath)}>
                <FileTypeIcon path={dirtyPath} />
                <span>{dirtyPath}</span>
                <span className={`code-tree-status is-${statusClass(dirtyStatus)}`}>{dirtyStatus === '?' ? 'U' : dirtyStatus}</span>
              </button>
            </li>)}
          </ul>
        </section> : null}
      </div>
    }
    if (!currentFile) return <div className="code-skeleton" aria-label="Chargement du fichier" />
    if (currentFile.error) return <p className="code-reader-message is-error">{currentFile.error}</p>
    const data = currentFile.value!
    if (data.binary) return <p className="code-reader-message">Fichier binaire : pas d’aperçu texte.</p>
    if (data.tooLarge) {
      return <p className="code-reader-message">Fichier trop volumineux pour l’aperçu ({(data.size / 1024 / 1024).toFixed(1)} Mo).</p>
    }

    if (mode === 'history') {
      const currentHistory = history?.key === key ? history : null
      if (!currentHistory) return <div className="code-skeleton" aria-label="Chargement de l’historique" />
      if (currentHistory.error) return <p className="code-reader-message is-error">{currentHistory.error}</p>
      const commits = currentHistory.value ?? []
      if (commits.length === 0) {
        return <p className="code-reader-message">Aucun commit ne touche encore ce fichier.</p>
      }
      return <div className="code-history" role="list" aria-label={`Historique de ${name}`}>
        {commits.map((commit) => {
          const linked = commit.conversations[0]
          return <button
            key={commit.sha}
            type="button"
            role="listitem"
            className={`code-history-row${commit.sha === selectedSha ? ' is-selected' : ''}`}
            onClick={() => onSelectCommit(commit.sha)}
          >
            <span className="code-history-date" title={absoluteCodeDate(commit.authoredAt)}>{relativeCodeDate(commit.authoredAt)}</span>
            <span className="code-history-subject">{commit.subject}</span>
            <span className="code-history-meta">
              <span>{commit.author}</span>
              {linked ? <span className="code-history-conversation"><ProviderMark provider={linked.provider} />{linked.title}</span> : null}
            </span>
            <span className="code-commit-sha">{commit.sha.slice(0, 8)}</span>
          </button>
        })}
      </div>
    }

    return <div className={`code-reader-scroll${mode === 'blame' ? ' is-blame' : ''}`} ref={lineWindow.ref}>
      <div className="code-lines" style={{ paddingTop: lineWindow.before, paddingBottom: lineWindow.after }}>
        {lines.slice(lineWindow.start, lineWindow.end).map((html, offset) => {
          const index = lineWindow.start + offset
          const entry = blameByLine[index]
          const className = [
            'code-line',
            openFile?.line === index + 1 ? 'is-target' : '',
            entry && entry.group.sha === selectedSha ? 'is-selected' : '',
          ].filter(Boolean).join(' ')
          return <div className={className} key={index}>
            {mode === 'blame'
              ? <BlameCell
                group={entry?.group}
                offset={entry?.offset ?? 0}
                selected={entry?.group.sha === selectedSha}
                onSelect={onSelectCommit}
                onOpenConversation={onOpenConversation}
              />
              : null}
            <span className="code-line-number">{index + 1}</span>
            <span className="code-line-text" dangerouslySetInnerHTML={{ __html: html || ' ' }} />
          </div>
        })}
      </div>
    </div>
  }

  return <div className="code-reader">
    <header className="code-reader-header">
      {path ? <>
        <FileTypeIcon path={path} />
        <nav className="code-breadcrumb" aria-label="Chemin du fichier" title={path}>
          {directory ? directory.split('/').map((segment, index) => <span className="code-breadcrumb-dir" key={`${segment}-${index}`}>{segment}</span>) : null}
          <strong>{name}</strong>
        </nav>
        {status ? <span className={`code-dirty-badge is-${statusClass(status)}`}>{DIRTY_LABELS[status]}</span> : null}
        {mode === 'blame' && !currentBlame ? <span className="code-reader-status">Blame en cours…</span> : null}
        {currentBlame?.error ? <span className="code-reader-status is-error" title={currentBlame.error}>Blame indisponible</span> : null}
      </> : <span className="code-reader-placeholder">Lecteur</span>}
      <div className="code-segmented" role="tablist" aria-label="Affichage du fichier">
        {MODES.map((item) => <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={mode === item.id}
          className={mode === item.id ? 'is-active' : ''}
          onClick={() => onModeChange(item.id)}
        >{item.label}</button>)}
      </div>
      {path ? <button
        type="button"
        className="code-icon-button"
        title="Copier le chemin"
        aria-label="Copier le chemin du fichier"
        onClick={() => void navigator.clipboard?.writeText(path)}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><g stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 3.5v-.5A1.5 1.5 0 0 0 9 1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5" /></g></svg>
      </button> : null}
    </header>
    {renderBody()}
  </div>
}
