import { useEffect, useMemo, useRef, type CSSProperties, type KeyboardEvent } from 'react'
import { absoluteCodeDate, relativeCodeDate } from './codeFormat'
import {
  CODE_GRAPH_LANE_WIDTH,
  codeGraphLaneX,
  codeGraphPaths,
  layoutCodeGraph,
  parseCodeRefs,
  type CodeGraphRow,
  type CodeRef,
} from './codeGraphLayout'
import { ProviderMark } from './ProviderMark'
import { useVirtualWindow } from './useVirtualWindow'
import type { CodeCommitSummary } from './types'

export interface CodeGraphState {
  source: string
  head: string | null
  currentBranch: string | null
  base: string | null
  focus: ReadonlySet<string>
  commits: CodeCommitSummary[]
  hasMore: boolean
  loadingMore: boolean
}

type CodeGraphLayout = 'compact' | 'table'

interface CodeGraphProps {
  graph: CodeGraphState | null
  error: string | null
  layout: CodeGraphLayout
  selectedSha: string | null
  returnLabel: string | null
  onSelect: (sha: string) => void
  onLoadMore: () => void
  onToggleExpanded: () => void
  onOpenConversation: (conversationId: string) => void
}

const ROW_HEIGHTS: Record<CodeGraphLayout, number> = { compact: 28, table: 34 }
const LANE_LIMITS: Record<CodeGraphLayout, number> = { compact: 8, table: 14 }

function RefPill({ gitRef }: { gitRef: CodeRef }) {
  return <span className={`code-ref is-${gitRef.kind}`} title={gitRef.label}>{gitRef.label}</span>
}

function GraphCell({ row, height, width, isHead }: {
  row: CodeGraphRow
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

export function CodeGraph({
  graph,
  error,
  layout,
  selectedSha,
  returnLabel,
  onSelect,
  onLoadMore,
  onToggleExpanded,
  onOpenConversation,
}: CodeGraphProps) {
  const commits = graph?.commits
  const rows = useMemo(() => layoutCodeGraph(commits ?? []), [commits])
  const rowHeight = ROW_HEIGHTS[layout]
  const laneLimit = LANE_LIMITS[layout]
  const listWindow = useVirtualWindow<HTMLDivElement>(rows.length, rowHeight)
  const { scrollToIndex } = listWindow
  const maxLanes = useMemo(() => rows.reduce((max, row) => Math.max(max, row.laneCount), 1), [rows])
  const cellWidth = Math.min(maxLanes, laneLimit) * CODE_GRAPH_LANE_WIDTH + 4
  const indexBySha = useMemo(() => new Map(rows.map((row, index) => [row.commit.sha, index])), [rows])

  const centeredKey = useRef<string | null>(null)
  const centerKey = graph ? `${graph.source}\n${layout}` : null
  useEffect(() => {
    if (!graph || centerKey === null || centeredKey.current === centerKey) return
    const index = indexBySha.get(selectedSha ?? graph.head ?? '')
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
    if (rows.length === 0) return
    const current = selectedSha ? indexBySha.get(selectedSha) ?? -1 : -1
    let next: number | null = null
    if (event.key === 'ArrowDown') next = Math.min(current + 1, rows.length - 1)
    else if (event.key === 'ArrowUp') next = Math.max(current - 1, 0)
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = rows.length - 1
    if (next === null) return
    event.preventDefault()
    onSelect(rows[next]!.commit.sha)
  }

  function revealHead() {
    if (!graph?.head) return
    onSelect(graph.head)
    const index = indexBySha.get(graph.head)
    if (index !== undefined) scrollToIndex(index, 'center')
  }

  const branch = graph?.currentBranch ?? (graph?.head ? `HEAD ${graph.head.slice(0, 7)}` : null)
  const summary = graph && branch
    ? graph.base && graph.focus.size > 0
      ? `${branch}, ${graph.focus.size} commit${graph.focus.size > 1 ? 's' : ''} d’avance sur ${graph.base}`
      : branch
    : ''

  function renderRow(row: CodeGraphRow) {
    const { commit } = row
    const selected = commit.sha === selectedSha
    const isHead = commit.sha === graph?.head
    const focus = isHead || Boolean(graph?.focus.has(commit.sha))
    const refs = parseCodeRefs(commit.refs)
    const linked = commit.conversations[0]
    const className = [
      'code-graph-row',
      `is-${layout}`,
      selected ? 'is-selected' : '',
      focus ? 'is-focus' : '',
      commit.parents.length > 1 ? 'is-merge' : '',
    ].filter(Boolean).join(' ')
    const cell = <GraphCell row={row} height={rowHeight} width={cellWidth} isHead={isHead} />

    if (layout === 'compact') {
      return <div
        key={commit.sha}
        role="option"
        aria-selected={selected}
        className={className}
        title={`${commit.subject}\n${commit.author}, ${absoluteCodeDate(commit.authoredAt)}`}
        onClick={() => onSelect(commit.sha)}
      >
        {cell}
        {refs.slice(0, 1).map((gitRef) => <RefPill key={gitRef.label} gitRef={gitRef} />)}
        <span className="code-graph-subject">{commit.subject}</span>
        {linked ? <ProviderMark provider={linked.provider} className="code-graph-provider" /> : null}
      </div>
    }

    return <div
      key={commit.sha}
      role="option"
      aria-selected={selected}
      className={className}
      onClick={() => onSelect(commit.sha)}
    >
      {cell}
      <span className="code-graph-subject" title={commit.subject}>{commit.subject}</span>
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
        </button> : null}
      </span>
      <span className="code-graph-author" title={commit.author}>{commit.author}</span>
      <span className="code-graph-date" title={absoluteCodeDate(commit.authoredAt)}>{relativeCodeDate(commit.authoredAt)}</span>
    </div>
  }

  return <div className={`code-graph is-${layout}`} style={{ '--graph-cell-width': `${cellWidth}px` } as CSSProperties}>
    <header className="code-pane-header">
      {layout === 'table' ? <button type="button" className="code-back-button" onClick={onToggleExpanded}>
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13 8H3M6.5 4.5 3 8l3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        <span>{returnLabel ? `Retour à ${returnLabel}` : 'Retour aux fichiers'}</span>
      </button> : null}
      <h2 className="code-pane-title">Graphe</h2>
      <span className="code-pane-meta" title={summary}>{summary}</span>
      <button type="button" className="code-icon-button" title="Revenir au HEAD de cet état du code" aria-label="Revenir au HEAD" onClick={revealHead}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><g stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"><circle cx="8" cy="8" r="5" /><circle cx="8" cy="8" r="1.6" /><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2" /></g></svg>
      </button>
      {layout === 'compact' ? <button type="button" className="code-expand-button" title="Afficher le graphe sur toute la largeur" onClick={onToggleExpanded}>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
        <span>Agrandir</span>
      </button> : null}
    </header>
    {error ? <p className="code-empty-note is-error">{error}</p> : null}
    {!graph && !error ? <div className="code-skeleton" aria-label="Chargement du graphe" /> : null}
    {graph && rows.length === 0 ? <p className="code-empty-note">Aucun commit dans ce dépôt.</p> : null}
    <div
      className="code-graph-list"
      ref={listWindow.ref}
      role="listbox"
      tabIndex={0}
      aria-label="Commits"
      onKeyDown={handleKeyDown}
      onScroll={(event) => {
        const element = event.currentTarget
        if (graph?.hasMore && !graph.loadingMore && element.scrollTop + element.clientHeight > element.scrollHeight - rowHeight * 30) {
          onLoadMore()
        }
      }}
    >
      {layout === 'table' && rows.length > 0 ? <div className="code-graph-table-head" aria-hidden="true">
        <span />
        <span>Message</span>
        <span>Branches</span>
        <span>Conversation</span>
        <span>Auteur</span>
        <span>Date</span>
      </div> : null}
      <div style={{ paddingTop: listWindow.before, paddingBottom: listWindow.after }}>
        {rows.slice(listWindow.start, listWindow.end).map(renderRow)}
      </div>
      {graph?.loadingMore ? <p className="code-graph-status">Chargement des commits suivants…</p> : null}
    </div>
  </div>
}
