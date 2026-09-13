import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getCodeGraph, listCodeFiles, listCodeSources, listProjectConversations, searchCode } from './api'
import { CodeCommitDetail } from './CodeCommitDetail'
import { CodeFileTree } from './CodeFileTree'
import { codeErrorMessage, splitCodePath } from './codeFormat'
import { CodeGraph, type CodeGraphState } from './CodeGraph'
import { mergeCodeCommits, type CodeGraphCommit } from './codeGraphLayout'
import { CodeReader, type CodeOpenFile, type CodeReaderMode } from './CodeReader'
import { buildCodeScopes, defaultCodeScope, fromScopePath, scopePrefixes, toScopePath } from './codeScopes'
import { CodeSourcePicker } from './CodeSourcePicker'
import { ancestorDirectories } from './codeTree'
import type { TicketLinks } from './ticketLinks'
import type { CodeCommitSummary, CodeDirtyStatus, CodeFileList, CodeSearchResult, CodeSource, Conversation, Project } from './types'

const READER_MODE_KEY = 'pupitre:code-reader-mode'
const AGENT_ONLY_KEY = 'pupitre:code-agent-only'

interface CodeViewProps {
  project: Project
  conversation: Conversation | null
  ticketLinks: ReadonlyMap<string, TicketLinks>
  onOpenConversation: (conversationId: string) => void
}

interface SourceFiles {
  list: CodeFileList | null
  error: string | null
}

interface SourceGraph {
  head: string | null
  currentBranch: string | null
  base: string | null
  focus: string[]
  focusCommits: CodeCommitSummary[]
  commits: CodeCommitSummary[]
  hasMore: boolean
  loadingMore: boolean
  error: string | null
}

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    return
  }
}

function storedReaderMode(): CodeReaderMode {
  const stored = readStorage(READER_MODE_KEY)
  return stored === 'blame' || stored === 'history' ? stored : 'code'
}

function singleGraphSummary(graph: SourceGraph): string {
  const branch = graph.currentBranch ?? (graph.head ? `HEAD ${graph.head.slice(0, 7)}` : '')
  if (!graph.base || graph.focus.length === 0) return branch
  return `${branch}, ${graph.focus.length} commit${graph.focus.length > 1 ? 's' : ''} d’avance sur ${graph.base}`
}

export function CodeView({ project, conversation, ticketLinks, onOpenConversation }: CodeViewProps) {
  const [sources, setSources] = useState<CodeSource[] | null>(null)
  const [sourcesError, setSourcesError] = useState<string | null>(null)
  const [scopeId, setScopeId] = useState<string | null>(null)
  const [files, setFiles] = useState<Record<string, SourceFiles>>({})
  const [graphs, setGraphs] = useState<Record<string, SourceGraph>>({})
  const [openFile, setOpenFile] = useState<CodeOpenFile | null>(null)
  const [expandedDirectories, setExpandedDirectories] = useState<ReadonlySet<string>>(() => new Set())
  const [readerMode, setReaderMode] = useState<CodeReaderMode>(storedReaderMode)
  const [selected, setSelected] = useState<{ sha: string, source: string } | null>(null)
  const [graphExpanded, setGraphExpanded] = useState(false)
  const [agentOnly, setAgentOnly] = useState(() => readStorage(AGENT_ONLY_KEY) === 'true')
  const [branchOnly, setBranchOnly] = useState(false)
  const [conversations, setConversations] = useState<ReadonlyMap<string, Conversation>>(() => new Map())
  const searchRef = useRef<HTMLInputElement | null>(null)
  const openCounter = useRef(0)
  const conversationId = conversation?.id ?? null
  const worktreePath = conversation?.worktree_path ?? null

  const scopes = useMemo(() => buildCodeScopes(sources ?? []), [sources])
  const scope = scopes.find((item) => item.id === scopeId) ?? null
  const scopeKey = scope ? scope.sources.map((source) => source.path).join('\n') : ''
  const prefixes = useMemo(() => (scope ? scopePrefixes(scope) : new Map<string, string>()), [scope])

  useEffect(() => {
    const controller = new AbortController()
    listCodeSources(project.id, controller.signal)
      .then((list) => {
        const nextScopes = buildCodeScopes(list)
        setSources(list)
        setScopeId((current) => {
          if (current && nextScopes.some((item) => item.id === current)) return current
          const chosen = defaultCodeScope(nextScopes, conversationId, worktreePath)
          setBranchOnly(nextScopes.find((item) => item.id === chosen)?.kind === 'ticket')
          return chosen
        })
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
    if (!scopeKey) return
    const controller = new AbortController()
    for (const source of scopeKey.split('\n')) {
      listCodeFiles(project.id, source, controller.signal)
        .then((list) => setFiles((current) => ({ ...current, [source]: { list, error: null } })))
        .catch((reason: unknown) => {
          if (!controller.signal.aborted) setFiles((current) => ({ ...current, [source]: { list: null, error: codeErrorMessage(reason) } }))
        })
    }
    return () => controller.abort()
  }, [project.id, scopeKey])

  useEffect(() => {
    if (!scopeKey) return
    const controller = new AbortController()
    const scopeSources = scopeKey.split('\n')
    for (const source of scopeSources) {
      getCodeGraph(project.id, source, 0, controller.signal)
        .then((page) => {
          setGraphs((current) => ({
            ...current,
            [source]: { ...page, loadingMore: false, error: null },
          }))
          if (source === scopeSources[0] && page.head) {
            const head = page.head
            setSelected((current) => current ?? { sha: head, source })
          }
        })
        .catch((reason: unknown) => {
          if (controller.signal.aborted) return
          setGraphs((current) => ({
            ...current,
            [source]: { head: null, currentBranch: null, base: null, focus: [], focusCommits: [], commits: [], hasMore: false, loadingMore: false, error: codeErrorMessage(reason) },
          }))
        })
    }
    return () => controller.abort()
  }, [project.id, scopeKey])

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

  const mergedFiles = useMemo((): SourceFiles => {
    if (!scope) return { list: null, error: null }
    const entries = scope.sources.map((source) => ({ source, entry: files[source.path] }))
    if (entries.some(({ entry }) => entry === undefined)) return { list: null, error: null }
    const merged: CodeFileList = { paths: [], submodules: [], dirty: [], truncated: false }
    for (const { source, entry } of entries) {
      const list = entry!.list
      if (!list) continue
      const prefix = prefixes.get(source.path) ?? ''
      const map = (path: string) => (prefix ? `${prefix}/${path}` : path)
      merged.paths.push(...list.paths.map(map))
      merged.submodules.push(...list.submodules.map(map))
      merged.dirty.push(...list.dirty.map((item) => ({ ...item, path: map(item.path) })))
      merged.truncated ||= list.truncated
    }
    const error = entries.find(({ entry }) => entry?.error)?.entry?.error ?? null
    const anyList = entries.some(({ entry }) => entry?.list)
    return { list: anyList ? merged : null, error }
  }, [scope, files, prefixes])

  const graphView = useMemo((): { state: CodeGraphState | null, error: string | null } => {
    if (!scope) return { state: null, error: null }
    const entries = scope.sources.map((source) => ({ source, graph: graphs[source.path] }))
    const error = entries.find(({ graph }) => graph?.error)?.graph?.error ?? null
    if (entries.some(({ graph }) => graph === undefined)) return { state: null, error }
    const multi = scope.sources.length > 1
    const merge = (pick: (graph: SourceGraph) => CodeCommitSummary[]): CodeGraphCommit[] => mergeCodeCommits(entries.map(({ source, graph }, index) => ({
      source: source.path,
      repoLabel: multi ? prefixes.get(source.path) ?? null : null,
      repoIndex: index,
      commits: pick(graph!),
    })))
    const commits = merge((graph) => graph.commits)
    const focusCommits = merge((graph) => graph.focusCommits)
    const primary = entries[0]!.graph!
    return {
      error,
      state: {
        key: scope.id,
        heads: new Set(entries.map(({ graph }) => graph!.head).filter((head): head is string => head !== null)),
        centerSha: primary.head,
        summary: multi ? `${scope.label}, ${scope.sources.length} dépôts` : singleGraphSummary(primary),
        focus: new Set(focusCommits.map((commit) => commit.sha)),
        focusCommits,
        commits,
        hasMore: entries.some(({ graph }) => graph!.hasMore),
        loadingMore: entries.some(({ graph }) => graph!.loadingMore),
      },
    }
  }, [scope, graphs, prefixes])

  const dirty = useMemo(
    () => new Map<string, CodeDirtyStatus>((mergedFiles.list?.dirty ?? []).map((item) => [item.path, item.status])),
    [mergedFiles],
  )

  const ticketForConversation = useCallback((id: string): TicketLinks | null => {
    const item = conversations.get(id)
    if (!item) return null
    return (item.ticket_key ? ticketLinks.get(item.ticket_key) : undefined)
      ?? (item.ticket_id ? ticketLinks.get(item.ticket_id) : undefined)
      ?? null
  }, [conversations, ticketLinks])

  const searchText = useCallback(async (query: string, signal: AbortSignal): Promise<CodeSearchResult> => {
    if (!scope) return { query, matches: [], truncated: false }
    const results = await Promise.all(scope.sources.map(async (source) => ({
      result: await searchCode(project.id, source.path, query, signal),
      prefix: prefixes.get(source.path) ?? '',
    })))
    return {
      query,
      matches: results.flatMap(({ result, prefix }) => result.matches.map((match) => ({ ...match, path: prefix ? `${prefix}/${match.path}` : match.path }))),
      truncated: results.some(({ result }) => result.truncated),
    }
  }, [project.id, scope, prefixes])

  function changeScope(id: string) {
    if (id === scopeId) return
    const next = scopes.find((item) => item.id === id)
    if (!next) return
    setScopeId(id)
    setSelected(null)
    setExpandedDirectories(new Set())
    setBranchOnly(next.kind === 'ticket')
    setOpenFile((current) => (
      current && next.sources.some((source) => source.path === current.source)
        ? { ...current, display: toScopePath(next, current.source, current.path) }
        : null
    ))
  }

  function openFileAt(display: string, line: number | null = null) {
    if (!scope) return
    const location = fromScopePath(scope, display)
    if (!location) return
    openCounter.current += 1
    setOpenFile({ display, source: location.source, path: location.path, line, nonce: openCounter.current })
    setExpandedDirectories((current) => {
      const next = new Set(current)
      for (const directory of ancestorDirectories(display)) next.add(directory)
      return next
    })
    setGraphExpanded(false)
  }

  function openRepository(display: string) {
    if (!scope || !sources) return
    const location = fromScopePath(scope, display)
    if (!location) return
    const target = sources.find((source) => source.main && source.path === `${location.source}/${location.path}`)
    if (target) changeScope(`source:${target.path}`)
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
    writeStorage(READER_MODE_KEY, mode)
  }

  function toggleAgentOnly() {
    setAgentOnly((value) => {
      writeStorage(AGENT_ONLY_KEY, String(!value))
      return !value
    })
  }

  function loadMoreCommits() {
    if (!scope) return
    for (const source of scope.sources) {
      const current = graphs[source.path]
      if (!current || !current.hasMore || current.loadingMore) continue
      const path = source.path
      setGraphs((previous) => ({ ...previous, [path]: { ...previous[path]!, loadingMore: true } }))
      getCodeGraph(project.id, path, current.commits.length)
        .then((page) => setGraphs((previous) => {
          const entry = previous[path]
          if (!entry) return previous
          const known = new Set(entry.commits.map((commit) => commit.sha))
          return {
            ...previous,
            [path]: { ...entry, commits: [...entry.commits, ...page.commits.filter((commit) => !known.has(commit.sha))], hasMore: page.hasMore, loadingMore: false },
          }
        }))
        .catch(() => setGraphs((previous) => (previous[path] ? { ...previous, [path]: { ...previous[path]!, loadingMore: false } } : previous)))
    }
  }

  if (sourcesError) {
    return <div className="code-view-message"><p className="code-empty-note is-error">{sourcesError}</p></div>
  }
  if (!sources) {
    return <div className="code-view-message"><div className="code-skeleton" aria-label="Chargement des dépôts" /></div>
  }
  if (sources.length === 0 || !scope) {
    return <div className="code-view-message">
      <div className="code-reader-empty">
        <h3>Aucun dépôt Git dans ce projet</h3>
        <p>L’explorateur lit les dépôts présents dans <code>{project.path}</code> et dans ses sous-dossiers.</p>
      </div>
    </div>
  }

  const selectedRepository = selected && scope.sources.length > 1
    ? { label: prefixes.get(selected.source) ?? '', index: Math.max(scope.sources.findIndex((source) => source.path === selected.source), 0) }
    : null
  const detailProps = selected ? {
    projectId: project.id,
    sourcePath: selected.source,
    sha: selected.sha,
    repository: selectedRepository,
    ticketForConversation,
    onOpenConversation,
    onOpenFile: (path: string) => openFileAt(toScopePath(scope, selected.source, path)),
    onSelectCommit: (sha: string) => setSelected({ sha, source: selected.source }),
  } : null

  return <div className={`code-view${graphExpanded ? ' is-graph-expanded' : ''}`}>
    <aside className="code-sidebar" hidden={graphExpanded} aria-label="Fichiers">
      <CodeSourcePicker
        scopes={scopes}
        value={scope.id}
        originConversationId={conversationId}
        onChange={changeScope}
      />
      <CodeFileTree
        key={scope.id}
        files={mergedFiles.list}
        error={mergedFiles.error}
        expanded={expandedDirectories}
        openPath={openFile?.display ?? null}
        searchRef={searchRef}
        searchText={searchText}
        onToggleDirectory={toggleDirectory}
        onOpenFile={openFileAt}
        onOpenRepository={openRepository}
      />
    </aside>

    <section className="code-reader-column" hidden={graphExpanded} aria-label="Lecteur de fichier">
      <CodeReader
        projectId={project.id}
        openFile={openFile}
        mode={readerMode}
        dirty={dirty}
        selectedSha={selected?.sha ?? null}
        active={!graphExpanded}
        onModeChange={changeReaderMode}
        onSelectCommit={(sha) => openFile && setSelected({ sha, source: openFile.source })}
        onOpenFile={(path) => openFileAt(path)}
        onOpenConversation={onOpenConversation}
      />
    </section>

    <section className="code-graph-column" aria-label="Graphe des commits">
      <CodeGraph
        graph={graphView.state}
        error={graphView.error}
        layout={graphExpanded ? 'table' : 'compact'}
        selectedSha={selected?.sha ?? null}
        returnLabel={openFile ? splitCodePath(openFile.display).name : null}
        agentOnly={agentOnly}
        branchOnly={branchOnly}
        onToggleAgentOnly={toggleAgentOnly}
        onToggleBranchOnly={() => setBranchOnly((value) => !value)}
        onSelect={(commit) => setSelected({ sha: commit.sha, source: commit.source })}
        onLoadMore={loadMoreCommits}
        onToggleExpanded={() => setGraphExpanded((value) => !value)}
        onOpenConversation={onOpenConversation}
      />
      {!graphExpanded && detailProps
        ? <CodeCommitDetail key={`${detailProps.sourcePath}-${detailProps.sha}`} {...detailProps} variant="docked" onClose={() => setSelected(null)} />
        : null}
    </section>

    {graphExpanded ? <aside className="code-detail-column" aria-label="Détail du commit">
      {detailProps
        ? <CodeCommitDetail key={`${detailProps.sourcePath}-${detailProps.sha}`} {...detailProps} variant="side" />
        : <p className="code-empty-note">Choisis un commit dans le graphe pour voir son détail.</p>}
    </aside> : null}
  </div>
}
