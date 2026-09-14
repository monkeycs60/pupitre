import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { absoluteCodeDate, relativeCodeDate } from './codeFormat'
import {
  CODE_GRAPH_LANE_WIDTH,
  codeGraphLaneX,
  codeGraphPaths,
  layoutCodeGraph,
  parseCodeRefs,
  type CodeGraphCommit,
  type CodeGraphRow,
  type CodeRef,
} from './codeGraphLayout'
import { ProviderMark } from './ProviderMark'
import { useVirtualWindow } from './useVirtualWindow'
import type { Provider } from './types'

export interface CodeGraphState {
  key: string
  heads: ReadonlySet<string>
  centerSha: string | null
  summary: string
  focus: ReadonlySet<string>
  focusCommits: CodeGraphCommit[]
  commits: CodeGraphCommit[]
  hasMore: boolean
  loadingMore: boolean
}

export interface CodeGraphConversationOption {
  id: string
  title: string
  provider: Provider
  count: number
}

export interface CodeGraphRepository {
  source: string
  label: string
  index: number
  hidden: boolean
}

type CodeGraphLayout = 'compact' | 'table'

interface CodeGraphProps {
  graph: CodeGraphState | null
  error: string | null
  layout: CodeGraphLayout
  selectedSha: string | null
  returnLabel: string | null
  branchOnly: boolean
  onToggleBranchOnly: () => void
  /** `all`, `linked`, `unlinked` ou `conversation:<id>`. */
  conversationFilter: string
  conversationOptions: CodeGraphConversationOption[]
  conversationCommits: CodeGraphCommit[] | null
  conversationNote: string | null
  onConversationFilterChange: (value: string) => void
  repositories: CodeGraphRepository[]
  onToggleRepository: (source: string) => void
  changesActive: boolean
  onToggleChanges: () => void
  onSelect: (commit: CodeGraphCommit) => void
  onLoadMore: () => void
  onToggleExpanded: () => void
  onOpenConversation: (conversationId: string) => void
  syncBar?: ReactNode
}

const ROW_HEIGHTS: Record<CodeGraphLayout, number> = { compact: 28, table: 34 }
const LANE_LIMITS: Record<CodeGraphLayout, number> = { compact: 8, table: 14 }
const DOT_CELL_WIDTH = 20

function RefPill({ gitRef }: { gitRef: CodeRef }) {
  return <span className={`code-ref is-${gitRef.kind}`} title={gitRef.label}>{gitRef.label}</span>
}

function RepoBadge({ commit }: { commit: CodeGraphCommit }) {
  if (!commit.repoLabel) return null
  return <span className={`code-repo-badge is-repo-${commit.repoIndex % 6}`} title={`Dépôt ${commit.repoLabel}`}>{commit.repoLabel}</span>
}

function OriginMark({ commit }: { commit: CodeGraphCommit }) {
  const linked = commit.conversations[0]
  const provider = linked?.provider ?? commit.agent?.provider
  if (!provider) return null
  return <span className="code-graph-provider" title={linked ? `Conversation « ${linked.title} »` : `Co-écrit par ${commit.agent?.name}`}>
    <ProviderMark provider={provider} />
  </span>
}

function GraphCell({ row, height, width, isHead }: {
  row: CodeGraphRow<CodeGraphCommit>
  height: number
  width: number
  isHead: boolean
}) {
  const merge = row.commit.parents.length > 1
  return <svg className="code-graph-cell" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
    {codeGraphPaths(row, height).map((path, index) => <path key={index} d={path.d} className={`code-graph-lane-${path.lane % 8}`} />)}
    <circle
      cx={codeGraphLaneX(row.lane)}
      cy={height / 2}
      r={isHead ? 4.6 : 3.6}
      className={`code-graph-dot code-graph-lane-${row.lane % 8}${merge ? ' is-merge' : ''}${isHead ? ' is-head' : ''}`}
    />
  </svg>
}

function DotCell({ commit, height, isHead }: { commit: CodeGraphCommit, height: number, isHead: boolean }) {
  return <svg className="code-graph-cell" width={DOT_CELL_WIDTH} height={height} viewBox={`0 0 ${DOT_CELL_WIDTH} ${height}`} aria-hidden="true">
    <circle cx={DOT_CELL_WIDTH / 2} cy={height / 2} r={isHead ? 4.6 : 3.6} className={`code-graph-dot code-graph-lane-${commit.repoIndex % 8}${isHead ? ' is-head' : ''}`} />
  </svg>
}

function ConversationFilterMenu({ value, options, linkedCount, unlinkedCount, onChange }: {
  value: string
  options: CodeGraphConversationOption[]
  linkedCount: number
  unlinkedCount: number
  onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const chosen = options.find((option) => `conversation:${option.id}` === value)
  const label = value === 'linked'
    ? 'Avec conversation'
    : value === 'unlinked' ? 'Sans conversation' : chosen ? chosen.title : 'Conversations'

  useEffect(() => {
    if (!open) return
    function handlePointer(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', handlePointer)
    return () => window.removeEventListener('mousedown', handlePointer)
  }, [open])

  function choose(next: string) {
    onChange(next)
    setOpen(false)
  }

  function option(optionValue: string, content: React.ReactNode, title?: string) {
    return <button
      key={optionValue}
      type="button"
      role="menuitemradio"
      aria-checked={value === optionValue}
      className={`code-conversation-option${value === optionValue ? ' is-current' : ''}`}
      title={title}
      onClick={() => choose(optionValue)}
    >{content}</button>
  }

  return <div
    className="code-conversation-filter"
    ref={rootRef}
    onKeyDown={(event) => {
      if (event.key === 'Escape' && open) {
        event.preventDefault()
        setOpen(false)
      }
    }}
  >
    <button
      type="button"
      className={`code-filter-toggle${value !== 'all' ? ' is-active' : ''}`}
      aria-haspopup="menu"
      aria-expanded={open}
      title="Filtrer par conversation d’origine"
      onClick={() => setOpen((current) => !current)}
    >
      {chosen
        ? <ProviderMark provider={chosen.provider} />
        : <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>}
      <span className="code-conversation-filter-label">{label}</span>
      <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4.5 6.5 3.5 3.5 3.5-3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </button>
    {open ? <div className="code-conversation-menu" role="menu" aria-label="Filtrer par conversation">
      {option('all', <span>Tous les commits</span>)}
      {option('linked', <><span>Avec une conversation</span><span className="code-filter-count">{linkedCount}</span></>)}
      {option('unlinked', <><span>Sans conversation</span><span className="code-filter-count">{unlinkedCount}</span></>)}
      {options.length > 0 ? <p className="code-conversation-menu-label">Conversations</p> : null}
      {options.map((item) => option(
        `conversation:${item.id}`,
        <><ProviderMark provider={item.provider} /><span className="code-conversation-menu-title">{item.title}</span><span className="code-filter-count">{item.count}</span></>,
        item.title,
      ))}
    </div> : null}
  </div>
}

export function CodeGraph({
  graph,
  error,
  layout,
  selectedSha,
  syncBar,
  returnLabel,
  branchOnly,
  onToggleBranchOnly,
  conversationFilter,
  conversationOptions,
  conversationCommits,
  conversationNote,
  onConversationFilterChange,
  repositories,
  onToggleRepository,
  changesActive,
  onToggleChanges,
  onSelect,
  onLoadMore,
  onToggleExpanded,
  onOpenConversation,
}: CodeGraphProps) {
  const commits = graph?.commits
  const focusCommits = graph?.focusCommits
  const focus = graph?.focus
  const specific = conversationFilter.startsWith('conversation:')
  const hidden = useMemo(() => new Set(repositories.filter((repository) => repository.hidden).map((repository) => repository.source)), [repositories])
  const pool = useMemo(
    () => ((branchOnly ? focusCommits : commits) ?? []).filter((commit) => !hidden.has(commit.source)),
    [branchOnly, focusCommits, commits, hidden],
  )
  const visible = useMemo(() => {
    if (specific) {
      return (conversationCommits ?? []).filter((commit) => !hidden.has(commit.source) && (!branchOnly || Boolean(focus?.has(commit.sha))))
    }
    if (conversationFilter === 'linked') return pool.filter((commit) => commit.conversations.length > 0)
    if (conversationFilter === 'unlinked') return pool.filter((commit) => commit.conversations.length === 0)
    return pool
  }, [specific, conversationCommits, hidden, branchOnly, focus, conversationFilter, pool])
  const lanes = !branchOnly && conversationFilter === 'all'
  const rows = useMemo(() => (lanes ? layoutCodeGraph(visible) : null), [visible, lanes])
  const linkedCount = useMemo(() => pool.filter((commit) => commit.conversations.length > 0).length, [pool])
  const branchCount = focusCommits?.length ?? 0
  const rowHeight = ROW_HEIGHTS[layout]
  const listWindow = useVirtualWindow<HTMLDivElement>(visible.length, rowHeight)
  const { scrollToIndex } = listWindow
  const maxLanes = useMemo(() => (rows ?? []).reduce((max, row) => Math.max(max, row.laneCount), 1), [rows])
  const cellWidth = rows ? Math.min(maxLanes, LANE_LIMITS[layout]) * CODE_GRAPH_LANE_WIDTH + 4 : DOT_CELL_WIDTH
  const indexBySha = useMemo(() => new Map(visible.map((commit, index) => [commit.sha, index])), [visible])

  const centeredKey = useRef<string | null>(null)
  const centerKey = graph ? `${graph.key}\n${layout}\n${branchOnly}\n${conversationFilter}\n${[...hidden].join(',')}` : null
  useEffect(() => {
    if (!graph || centerKey === null || centeredKey.current === centerKey) return
    const index = indexBySha.get(selectedSha ?? graph.centerSha ?? '')
    if (index === undefined) return
    centeredKey.current = centerKey
    scrollToIndex(index, 'center')
  }, [centerKey, graph, indexBySha, selectedSha, scrollToIndex])

  const revealedSha = useRef<string | null>(null)
  useEffect(() => {
    if (!selectedSha || revealedSha.current === selectedSha) return
    const index = indexBySha.get(selectedSha)
    if (index === undefined) return
    revealedSha.current = selectedSha
    scrollToIndex(index, 'nearest')
  }, [selectedSha, indexBySha, scrollToIndex])

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (visible.length === 0) return
    const current = selectedSha ? indexBySha.get(selectedSha) ?? -1 : -1
    let next: number | null = null
    if (event.key === 'ArrowDown') next = Math.min(current + 1, visible.length - 1)
    else if (event.key === 'ArrowUp') next = Math.max(current - 1, 0)
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = visible.length - 1
    if (next === null) return
    event.preventDefault()
    onSelect(visible[next]!)
  }

  function revealHead() {
    const index = indexBySha.get(graph?.centerSha ?? '')
    if (index === undefined) return
    onSelect(visible[index]!)
    scrollToIndex(index, 'center')
  }

  function renderRow(commit: CodeGraphCommit, index: number) {
    const row = rows?.[index]
    const selected = commit.sha === selectedSha
    const isHead = Boolean(graph?.heads.has(commit.sha))
    const inFocus = isHead || Boolean(graph?.focus.has(commit.sha))
    const refs = parseCodeRefs(commit.refs)
    const linked = commit.conversations[0]
    const className = [
      'code-graph-row',
      `is-${layout}`,
      selected ? 'is-selected' : '',
      inFocus ? 'is-focus' : '',
      commit.parents.length > 1 ? 'is-merge' : '',
    ].filter(Boolean).join(' ')
    const cell = row
      ? <GraphCell row={row} height={rowHeight} width={cellWidth} isHead={isHead} />
      : <DotCell commit={commit} height={rowHeight} isHead={isHead} />

    if (layout === 'compact') {
      return <div
        key={`${commit.source}-${commit.sha}`}
        role="option"
        aria-selected={selected}
        className={className}
        title={`${commit.subject}\n${commit.author}, ${absoluteCodeDate(commit.authoredAt)}`}
        onClick={() => onSelect(commit)}
      >
        {cell}
        <RepoBadge commit={commit} />
        {refs.slice(0, 1).map((gitRef) => <RefPill key={gitRef.label} gitRef={gitRef} />)}
        <span className="code-graph-subject">{commit.subject}</span>
        <OriginMark commit={commit} />
      </div>
    }

    return <div
      key={`${commit.source}-${commit.sha}`}
      role="option"
      aria-selected={selected}
      className={className}
      onClick={() => onSelect(commit)}
    >
      {cell}
      <span className="code-graph-message">
        <RepoBadge commit={commit} />
        <span className="code-graph-subject" title={commit.subject}>{commit.subject}</span>
      </span>
      <span className="code-graph-refs">
        {refs.slice(0, 2).map((gitRef) => <RefPill key={gitRef.label} gitRef={gitRef} />)}
        {refs.length > 2 ? <span className="code-ref is-more" title={refs.slice(2).map((gitRef) => gitRef.label).join(', ')}>+{refs.length - 2}</span> : null}
      </span>
      <span className="code-graph-conversation">
        {linked ? <button
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
        </button> : commit.agent ? <span className="code-graph-agent" title={`Co-écrit par ${commit.agent.name}`}>
          <ProviderMark provider={commit.agent.provider} />
          <span>{commit.agent.name}</span>
        </span> : null}
      </span>
      <span className="code-graph-author" title={commit.author}>{commit.author}</span>
      <span className="code-graph-date" title={absoluteCodeDate(commit.authoredAt)}>{relativeCodeDate(commit.authoredAt)}</span>
    </div>
  }

  const filtered = !lanes || hidden.size > 0

  return <div className={`code-graph is-${layout}`} style={{ '--graph-cell-width': `${cellWidth}px` } as CSSProperties}>
    <header className="code-pane-header">
      {layout === 'table' ? <button type="button" className="code-back-button" onClick={onToggleExpanded}>
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13 8H3M6.5 4.5 3 8l3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        <span>{returnLabel ? `Retour à ${returnLabel}` : 'Retour aux fichiers'}</span>
      </button> : null}
      <h2 className="code-pane-title">Graphe</h2>
      <span className="code-pane-meta" title={graph?.summary}>{graph?.summary ?? ''}</span>
      <button type="button" className="code-icon-button" title="Revenir au HEAD de cet état du code" aria-label="Revenir au HEAD" onClick={revealHead}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><g stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"><circle cx="8" cy="8" r="5" /><circle cx="8" cy="8" r="1.6" /><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2" /></g></svg>
      </button>
      {layout === 'compact' ? <button type="button" className="code-expand-button" title="Afficher le graphe sur toute la largeur" onClick={onToggleExpanded}>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
        <span>Agrandir</span>
      </button> : null}
    </header>
    {syncBar}
    {graph ? <div className="code-graph-filters" role="group" aria-label="Filtrer le graphe">
      {branchCount > 0 ? <button
        type="button"
        className={`code-filter-toggle${branchOnly ? ' is-active' : ''}`}
        aria-pressed={branchOnly}
        title="N’afficher que les commits de la branche"
        onClick={onToggleBranchOnly}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><g stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"><circle cx="4.5" cy="3.5" r="1.5" /><circle cx="4.5" cy="12.5" r="1.5" /><circle cx="11.5" cy="5.5" r="1.5" /><path d="M4.5 5v6M11.5 7c0 3-7 2-7 4" /></g></svg>
        <span>Branche</span>
        <span className="code-filter-count">{branchCount}</span>
      </button> : null}
      <ConversationFilterMenu
        value={conversationFilter}
        options={conversationOptions}
        linkedCount={linkedCount}
        unlinkedCount={pool.length - linkedCount}
        onChange={onConversationFilterChange}
      />
      {branchCount > 0 ? <button
        type="button"
        className={`code-filter-toggle${changesActive ? ' is-active' : ''}`}
        aria-pressed={changesActive}
        title="Lister les fichiers modifiés par la branche, sur tous les dépôts"
        onClick={onToggleChanges}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5 2.5v6M2 5.5h6M9 12.5h5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
        <span>Diff du chantier</span>
      </button> : null}
    </div> : null}
    {repositories.length > 1 ? <div className="code-graph-repos" role="group" aria-label="Dépôts affichés">
      {repositories.map((repository) => <button
        key={repository.source}
        type="button"
        className={`code-repo-chip is-repo-${repository.index % 6}${repository.hidden ? ' is-hidden' : ''}`}
        aria-pressed={!repository.hidden}
        title={repository.hidden ? `Afficher ${repository.label}` : `Masquer ${repository.label}`}
        onClick={() => onToggleRepository(repository.source)}
      >{repository.label}</button>)}
    </div> : null}
    {conversationNote ? <p className="code-graph-note">{conversationNote}</p> : null}
    {error ? <p className="code-empty-note is-error">{error}</p> : null}
    {!graph && !error ? <div className="code-skeleton" aria-label="Chargement du graphe" /> : null}
    {graph && specific && conversationCommits === null ? <div className="code-skeleton" aria-label="Chargement des commits de la conversation" /> : null}
    {graph && !filtered && visible.length === 0 ? <p className="code-empty-note">Aucun commit dans ce dépôt.</p> : null}
    {graph && filtered && visible.length === 0 && !(specific && conversationCommits === null)
      ? <p className="code-empty-note">Aucun commit ne correspond aux filtres.</p>
      : null}
    <div
      className="code-graph-list"
      ref={listWindow.ref}
      role="listbox"
      tabIndex={0}
      aria-label="Commits"
      onKeyDown={handleKeyDown}
      onScroll={(event) => {
        const element = event.currentTarget
        if (!branchOnly && !specific && graph?.hasMore && !graph.loadingMore && element.scrollTop + element.clientHeight > element.scrollHeight - rowHeight * 30) {
          onLoadMore()
        }
      }}
    >
      {layout === 'table' && visible.length > 0 ? <div className="code-graph-table-head" aria-hidden="true">
        <span />
        <span>Message</span>
        <span>Branches</span>
        <span>Origine</span>
        <span>Auteur</span>
        <span>Date</span>
      </div> : null}
      <div style={{ paddingTop: listWindow.before, paddingBottom: listWindow.after }}>
        {visible.slice(listWindow.start, listWindow.end).map((commit, offset) => renderRow(commit, listWindow.start + offset))}
      </div>
      {graph?.hasMore && !branchOnly && !specific ? <button type="button" className="code-graph-more" disabled={graph.loadingMore} onClick={onLoadMore}>
        {graph.loadingMore ? 'Chargement des commits suivants…' : 'Charger plus de commits'}
      </button> : null}
    </div>
  </div>
}
