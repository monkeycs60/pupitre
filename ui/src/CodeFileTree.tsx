import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { searchCode } from './api'
import { codeErrorMessage, DIRTY_LABELS, splitCodePath } from './codeFormat'
import { ancestorDirectories, buildCodeTree, flattenCodeTree, matchCodePaths } from './codeTree'
import { FileTypeIcon, FolderIcon } from './FileTypeIcon'
import { useVirtualWindow } from './useVirtualWindow'
import type { CodeDirtyStatus, CodeFileList, CodeSearchResult } from './types'

const TREE_ROW_HEIGHT = 26
const FILE_RESULT_LIMIT = 60
const TEXT_SEARCH_MIN = 3

interface CodeFileTreeProps {
  projectId: string
  sourcePath: string | null
  files: CodeFileList | null
  error: string | null
  expanded: ReadonlySet<string>
  openPath: string | null
  searchRef: RefObject<HTMLInputElement | null>
  onToggleDirectory: (path: string) => void
  onOpenFile: (path: string, line?: number | null) => void
}

type SearchItem = { kind: 'file', path: string, indices: number[] } | { kind: 'line', path: string, line: number, text: string }

function statusClass(status: CodeDirtyStatus): string {
  return status === '?' ? 'untracked' : status.toLowerCase()
}

function markedName(path: string, indices: number[]): ReactNode {
  const nameStart = path.lastIndexOf('/') + 1
  const marked = new Set(indices)
  const name = path.slice(nameStart)
  const parts: ReactNode[] = []
  let buffer = ''
  let bufferMarked = false
  const flush = (key: number) => {
    if (!buffer) return
    parts.push(bufferMarked ? <mark key={key}>{buffer}</mark> : buffer)
    buffer = ''
  }
  for (let index = 0; index < name.length; index += 1) {
    const isMarked = marked.has(nameStart + index)
    if (isMarked !== bufferMarked) {
      flush(index)
      bufferMarked = isMarked
    }
    buffer += name[index]
  }
  flush(name.length)
  return parts
}

function markedSnippet(text: string, query: string): ReactNode {
  const trimmed = text.replace(/^\s+/, '')
  const found = trimmed.toLowerCase().indexOf(query.toLowerCase())
  if (found === -1) return trimmed
  return <>
    {trimmed.slice(0, found)}
    <mark>{trimmed.slice(found, found + query.length)}</mark>
    {trimmed.slice(found + query.length)}
  </>
}

export function CodeFileTree({
  projectId,
  sourcePath,
  files,
  error,
  expanded,
  openPath,
  searchRef,
  onToggleDirectory,
  onOpenFile,
}: CodeFileTreeProps) {
  const [query, setQuery] = useState('')
  const [dirtyOnly, setDirtyOnly] = useState(false)
  const [textSearch, setTextSearch] = useState<{ query: string, result: CodeSearchResult | null, error: string | null } | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const trimmed = query.trim()

  const dirtyStatus = useMemo(() => new Map((files?.dirty ?? []).map((item) => [item.path, item.status])), [files])
  const dirtyPaths = useMemo(() => {
    if (!files) return []
    const present = new Set(files.paths)
    return files.dirty.filter((item) => item.status !== 'D' && present.has(item.path)).map((item) => item.path)
  }, [files])
  const allPaths = files?.paths
  const visiblePaths = useMemo(() => (dirtyOnly ? dirtyPaths : allPaths ?? []), [dirtyOnly, dirtyPaths, allPaths])
  const tree = useMemo(() => buildCodeTree(visiblePaths), [visiblePaths])
  const dirtyExpanded = useMemo(() => new Set(dirtyPaths.flatMap(ancestorDirectories)), [dirtyPaths])
  const rows = useMemo(() => flattenCodeTree(tree, dirtyOnly ? dirtyExpanded : expanded), [tree, dirtyOnly, dirtyExpanded, expanded])
  const treeWindow = useVirtualWindow<HTMLDivElement>(rows.length, TREE_ROW_HEIGHT)
  const fileMatches = useMemo(
    () => (files && trimmed ? matchCodePaths(files.paths, trimmed, FILE_RESULT_LIMIT) : []),
    [files, trimmed],
  )

  useEffect(() => {
    if (!sourcePath || trimmed.length < TEXT_SEARCH_MIN) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      searchCode(projectId, sourcePath, trimmed, controller.signal)
        .then((result) => setTextSearch({ query: trimmed, result, error: null }))
        .catch((reason: unknown) => {
          if (!controller.signal.aborted) setTextSearch({ query: trimmed, result: null, error: codeErrorMessage(reason) })
        })
    }, 320)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [projectId, sourcePath, trimmed])

  const revealedPath = useRef<string | null>(null)
  const { scrollToIndex } = treeWindow
  useEffect(() => {
    if (!openPath || revealedPath.current === openPath) return
    const index = rows.findIndex((row) => row.node.path === openPath)
    if (index === -1) return
    revealedPath.current = openPath
    scrollToIndex(index, 'center')
  }, [openPath, rows, scrollToIndex])

  const textResult = textSearch?.query === trimmed ? textSearch : null
  const items: SearchItem[] = [
    ...fileMatches.map((match): SearchItem => ({ kind: 'file', path: match.path, indices: match.indices })),
    ...(textResult?.result?.matches ?? []).map((match): SearchItem => ({ kind: 'line', ...match })),
  ]
  const boundedActive = Math.min(activeIndex, Math.max(items.length - 1, 0))

  function openItem(item: SearchItem | undefined) {
    if (!item) return
    onOpenFile(item.path, item.kind === 'line' ? item.line : null)
    if (item.kind === 'file') setQuery('')
  }

  function renderItem(item: SearchItem, index: number) {
    const active = index === boundedActive
    const { directory } = splitCodePath(item.path)
    if (item.kind === 'file') {
      return <button
        key={`file-${item.path}`}
        type="button"
        role="option"
        aria-selected={active}
        className={`code-search-item${active ? ' is-active' : ''}`}
        onMouseEnter={() => setActiveIndex(index)}
        onClick={() => openItem(item)}
      >
        <FileTypeIcon path={item.path} />
        <span className="code-search-name">{markedName(item.path, item.indices)}</span>
        <span className="code-search-dir">{directory}</span>
      </button>
    }
    return <button
      key={`line-${item.path}-${item.line}`}
      type="button"
      role="option"
      aria-selected={active}
      className={`code-search-line${active ? ' is-active' : ''}`}
      onMouseEnter={() => setActiveIndex(index)}
      onClick={() => openItem(item)}
    >
      <span className="code-search-line-number">{item.line}</span>
      <span className="code-search-snippet">{markedSnippet(item.text, trimmed)}</span>
    </button>
  }

  function renderTextResults() {
    if (trimmed.length < TEXT_SEARCH_MIN) {
      return <p className="code-empty-note">Tape au moins {TEXT_SEARCH_MIN} caractères pour chercher dans le code.</p>
    }
    if (!textResult) return <p className="code-empty-note">Recherche dans le code…</p>
    if (textResult.error) return <p className="code-empty-note is-error">{textResult.error}</p>
    const matches = textResult.result?.matches ?? []
    if (matches.length === 0) return <p className="code-empty-note">Aucune ligne ne contient « {trimmed} ».</p>
    const nodes: ReactNode[] = []
    let previousPath: string | null = null
    matches.forEach((match, offset) => {
      if (match.path !== previousPath) {
        previousPath = match.path
        nodes.push(<p className="code-search-file" key={`head-${match.path}-${offset}`}>
          <FileTypeIcon path={match.path} size={14} />
          <span>{match.path}</span>
        </p>)
      }
      nodes.push(renderItem({ kind: 'line', ...match }, fileMatches.length + offset))
    })
    return <>
      {nodes}
      {textResult.result?.truncated ? <p className="code-truncated-note">Résultats limités aux {matches.length} premières lignes.</p> : null}
    </>
  }

  return <div className="code-file-tree">
    <div className="code-search">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><circle cx="7" cy="7" r="4.2" /><path d="m10.2 10.2 3 3" /></g></svg>
      <input
        ref={searchRef}
        className="code-search-input"
        type="search"
        value={query}
        placeholder="Fichier ou texte"
        aria-label="Chercher un fichier ou du texte"
        spellCheck={false}
        onChange={(event) => {
          setQuery(event.target.value)
          setActiveIndex(0)
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setActiveIndex(Math.min(boundedActive + 1, items.length - 1))
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            setActiveIndex(Math.max(boundedActive - 1, 0))
          } else if (event.key === 'Enter') {
            event.preventDefault()
            openItem(items[boundedActive])
          } else if (event.key === 'Escape' && query !== '') {
            event.preventDefault()
            setQuery('')
          }
        }}
      />
      <kbd className="code-search-kbd">Ctrl P</kbd>
    </div>

    {trimmed ? <div className="code-search-results" role="listbox" aria-label="Résultats de recherche">
      <p className="code-search-heading">Fichiers</p>
      {fileMatches.length === 0
        ? <p className="code-empty-note">Aucun fichier ne correspond.</p>
        : fileMatches.map((match, index) => renderItem({ kind: 'file', path: match.path, indices: match.indices }, index))}
      <p className="code-search-heading">Dans le contenu</p>
      {renderTextResults()}
    </div> : <>
      <div className="code-tree-toolbar">
        {files && files.dirty.length > 0 ? <button
          type="button"
          className={`code-filter-button${dirtyOnly ? ' is-active' : ''}`}
          aria-pressed={dirtyOnly}
          onClick={() => setDirtyOnly((value) => !value)}
        >
          {files.dirty.length} {files.dirty.length > 1 ? 'modifiés' : 'modifié'}
        </button> : null}
        <span className="code-tree-count">{files ? `${files.paths.length.toLocaleString('fr-FR')} fichiers` : ''}</span>
      </div>
      {error ? <p className="code-empty-note is-error">{error}</p> : null}
      {!files && !error ? <div className="code-skeleton" aria-label="Chargement des fichiers" /> : null}
      {files?.truncated ? <p className="code-truncated-note">Arborescence limitée : le dépôt dépasse 60 000 fichiers.</p> : null}
      <div className="code-tree" ref={treeWindow.ref} role="tree" aria-label="Arborescence">
        <div style={{ paddingTop: treeWindow.before, paddingBottom: treeWindow.after }}>
          {rows.slice(treeWindow.start, treeWindow.end).map((row) => {
            const isDirectory = row.node.kind === 'directory'
            const isOpen = isDirectory && (dirtyOnly || expanded.has(row.node.path))
            const status = isDirectory ? undefined : dirtyStatus.get(row.node.path)
            const active = row.node.path === openPath
            return <button
              key={row.node.path}
              type="button"
              role="treeitem"
              aria-expanded={isDirectory ? isOpen : undefined}
              aria-selected={active}
              className={`code-tree-row${active ? ' is-active' : ''}`}
              style={{ paddingLeft: 8 + row.depth * 14 }}
              title={row.node.path}
              onClick={() => (isDirectory ? onToggleDirectory(row.node.path) : onOpenFile(row.node.path))}
            >
              {isDirectory
                ? <svg className={`code-tree-chevron${isOpen ? ' is-open' : ''}`} width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m6 3.5 4.5 4.5L6 12.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                : <span className="code-tree-spacer" />}
              {isDirectory ? <FolderIcon open={isOpen} /> : <FileTypeIcon path={row.node.path} />}
              <span className="code-tree-label">{row.label}</span>
              {status ? <span className={`code-tree-status is-${statusClass(status)}`} title={DIRTY_LABELS[status]}>{status === '?' ? 'U' : status}</span> : null}
            </button>
          })}
        </div>
      </div>
    </>}
  </div>
}
