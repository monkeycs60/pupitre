import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getCodeGraph, listCodeFiles, listCodeSources, listProjectConversations } from './api'
import { CodeCommitDetail } from './CodeCommitDetail'
import { CodeFileTree } from './CodeFileTree'
import { codeErrorMessage, defaultCodeSource, splitCodePath } from './codeFormat'
import { CodeGraph, type CodeGraphState } from './CodeGraph'
import { CodeReader, type CodeOpenFile, type CodeReaderMode } from './CodeReader'
import { CodeSourcePicker } from './CodeSourcePicker'
import { ancestorDirectories } from './codeTree'
import type { TicketLinks } from './ticketLinks'
import type { CodeDirtyStatus, CodeFileList, CodeSource, Conversation, Project } from './types'

const READER_MODE_KEY = 'pupitre:code-reader-mode'

interface CodeViewProps {
  project: Project
  conversation: Conversation | null
  ticketLinks: ReadonlyMap<string, TicketLinks>
  onOpenConversation: (conversationId: string) => void
}

function storedReaderMode(): CodeReaderMode {
  try {
    const stored = window.localStorage.getItem(READER_MODE_KEY)
    return stored === 'blame' || stored === 'history' ? stored : 'code'
  } catch {
    return 'code'
  }
}

export function CodeView({ project, conversation, ticketLinks, onOpenConversation }: CodeViewProps) {
  const [sources, setSources] = useState<CodeSource[] | null>(null)
  const [sourcesError, setSourcesError] = useState<string | null>(null)
  const [sourcePath, setSourcePath] = useState<string | null>(null)
  const [files, setFiles] = useState<{ source: string, list: CodeFileList | null, error: string | null } | null>(null)
  const [graph, setGraph] = useState<CodeGraphState | null>(null)
  const [graphError, setGraphError] = useState<{ source: string, message: string } | null>(null)
  const [openFile, setOpenFile] = useState<CodeOpenFile | null>(null)
  const [expandedDirectories, setExpandedDirectories] = useState<ReadonlySet<string>>(() => new Set())
  const [readerMode, setReaderMode] = useState<CodeReaderMode>(storedReaderMode)
  const [selectedSha, setSelectedSha] = useState<string | null>(null)
  const [graphExpanded, setGraphExpanded] = useState(false)
  const [conversations, setConversations] = useState<ReadonlyMap<string, Conversation>>(() => new Map())
  const searchRef = useRef<HTMLInputElement | null>(null)
  const openCounter = useRef(0)
  const conversationId = conversation?.id ?? null
  const worktreePath = conversation?.worktree_path ?? null

  useEffect(() => {
    const controller = new AbortController()
    listCodeSources(project.id, controller.signal)
      .then((list) => {
        setSources(list)
        setSourcePath((current) => (
          current && list.some((source) => source.path === current)
            ? current
            : defaultCodeSource(list, conversationId, worktreePath)
        ))
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setSourcesError(codeErrorMessage(reason))
      })
    let active = true
    listProjectConversations(project.id)
      .then((list) => {
        if (active) setConversations(new Map(list.map((item) => [item.id, item])))
      })
      .catch(() => {})
    return () => {
      controller.abort()
      active = false
    }
  }, [project.id, conversationId, worktreePath])

  useEffect(() => {
    if (!sourcePath) return
    const controller = new AbortController()
    listCodeFiles(project.id, sourcePath, controller.signal)
      .then((list) => setFiles({ source: sourcePath, list, error: null }))
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setFiles({ source: sourcePath, list: null, error: codeErrorMessage(reason) })
      })
    return () => controller.abort()
  }, [project.id, sourcePath])

  useEffect(() => {
    if (!sourcePath) return
    const controller = new AbortController()
    getCodeGraph(project.id, sourcePath, 0, controller.signal)
      .then((page) => {
        setGraph({
          source: sourcePath,
          head: page.head,
          currentBranch: page.currentBranch,
          base: page.base,
          focus: new Set(page.focus),
          commits: page.commits,
          hasMore: page.hasMore,
          loadingMore: false,
        })
        setGraphError(null)
        setSelectedSha((current) => current ?? page.head)
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setGraphError({ source: sourcePath, message: codeErrorMessage(reason) })
      })
    return () => controller.abort()
  }, [project.id, sourcePath])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const modifier = event.ctrlKey || event.metaKey
      if (modifier && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'p') {
        event.preventDefault()
        const focusSearch = () => {
          searchRef.current?.focus()
          searchRef.current?.select()
        }
        if (graphExpanded) {
          setGraphExpanded(false)
          window.requestAnimationFrame(focusSearch)
        } else {
          focusSearch()
        }
      } else if (event.key === 'Escape' && graphExpanded) {
        event.preventDefault()
        setGraphExpanded(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [graphExpanded])

  const currentGraph = graph?.source === sourcePath ? graph : null
  const currentFiles = files?.source === sourcePath ? files : null
  const dirty = useMemo(
    () => new Map<string, CodeDirtyStatus>((currentFiles?.list?.dirty ?? []).map((item) => [item.path, item.status])),
    [currentFiles],
  )

  const ticketForConversation = useCallback((conversationId: string): TicketLinks | null => {
    const item = conversations.get(conversationId)
    if (!item) return null
    return (item.ticket_key ? ticketLinks.get(item.ticket_key) : undefined)
      ?? (item.ticket_id ? ticketLinks.get(item.ticket_id) : undefined)
      ?? null
  }, [conversations, ticketLinks])

  function changeSource(path: string) {
    if (path === sourcePath) return
    setSourcePath(path)
    setSelectedSha(null)
  }

  function openFileAt(path: string, line: number | null = null) {
    openCounter.current += 1
    setOpenFile({ path, line, nonce: openCounter.current })
    setExpandedDirectories((current) => {
      const next = new Set(current)
      for (const directory of ancestorDirectories(path)) next.add(directory)
      return next
    })
    setGraphExpanded(false)
  }

  function toggleDirectory(path: string) {
    setExpandedDirectories((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  function changeReaderMode(mode: CodeReaderMode) {
    setReaderMode(mode)
    try {
      window.localStorage.setItem(READER_MODE_KEY, mode)
    } catch {
      return
    }
  }

  function loadMoreCommits() {
    if (!currentGraph || !currentGraph.hasMore || currentGraph.loadingMore || !sourcePath) return
    const source = sourcePath
    setGraph({ ...currentGraph, loadingMore: true })
    getCodeGraph(project.id, source, currentGraph.commits.length)
      .then((page) => setGraph((current) => {
        if (!current || current.source !== source) return current
        const known = new Set(current.commits.map((commit) => commit.sha))
        return {
          ...current,
          commits: [...current.commits, ...page.commits.filter((commit) => !known.has(commit.sha))],
          hasMore: page.hasMore,
          loadingMore: false,
        }
      }))
      .catch(() => setGraph((current) => (current && current.source === source ? { ...current, loadingMore: false } : current)))
  }

  if (sourcesError) {
    return <div className="code-view-message"><p className="code-empty-note is-error">{sourcesError}</p></div>
  }
  if (!sources) {
    return <div className="code-view-message"><div className="code-skeleton" aria-label="Chargement des dépôts" /></div>
  }
  if (sources.length === 0 || !sourcePath) {
    return <div className="code-view-message">
      <div className="code-reader-empty">
        <h3>Aucun dépôt Git dans ce projet</h3>
        <p>L’explorateur lit les dépôts présents dans <code>{project.path}</code> et dans ses sous-dossiers.</p>
      </div>
    </div>
  }

  const detailProps = {
    projectId: project.id,
    sourcePath,
    ticketForConversation,
    onOpenConversation,
    onOpenFile: (path: string) => openFileAt(path),
    onSelectCommit: setSelectedSha,
  }

  return <div className={`code-view${graphExpanded ? ' is-graph-expanded' : ''}`}>
    <aside className="code-sidebar" hidden={graphExpanded} aria-label="Fichiers">
      <CodeSourcePicker
        sources={sources}
        value={sourcePath}
        originConversationId={conversation?.id ?? null}
        onChange={changeSource}
      />
      <CodeFileTree
        key={sourcePath}
        projectId={project.id}
        sourcePath={sourcePath}
        files={currentFiles?.list ?? null}
        error={currentFiles?.error ?? null}
        expanded={expandedDirectories}
        openPath={openFile?.path ?? null}
        searchRef={searchRef}
        onToggleDirectory={toggleDirectory}
        onOpenFile={openFileAt}
      />
    </aside>

    <section className="code-reader-column" hidden={graphExpanded} aria-label="Lecteur de fichier">
      <CodeReader
        projectId={project.id}
        sourcePath={sourcePath}
        openFile={openFile}
        mode={readerMode}
        dirty={dirty}
        selectedSha={selectedSha}
        active={!graphExpanded}
        onModeChange={changeReaderMode}
        onSelectCommit={setSelectedSha}
        onOpenFile={(path) => openFileAt(path)}
        onOpenConversation={onOpenConversation}
      />
    </section>

    <section className="code-graph-column" aria-label="Graphe des commits">
      <CodeGraph
        graph={currentGraph}
        error={graphError?.source === sourcePath ? graphError.message : null}
        layout={graphExpanded ? 'table' : 'compact'}
        selectedSha={selectedSha}
        returnLabel={openFile ? splitCodePath(openFile.path).name : null}
        onSelect={setSelectedSha}
        onLoadMore={loadMoreCommits}
        onToggleExpanded={() => setGraphExpanded((value) => !value)}
        onOpenConversation={onOpenConversation}
      />
      {!graphExpanded && selectedSha
        ? <CodeCommitDetail key={`${sourcePath}-${selectedSha}`} {...detailProps} sha={selectedSha} variant="docked" onClose={() => setSelectedSha(null)} />
        : null}
    </section>

    {graphExpanded ? <aside className="code-detail-column" aria-label="Détail du commit">
      {selectedSha
        ? <CodeCommitDetail key={`${sourcePath}-${selectedSha}`} {...detailProps} sha={selectedSha} variant="side" />
        : <p className="code-empty-note">Choisis un commit dans le graphe pour voir son détail.</p>}
    </aside> : null}
  </div>
}
