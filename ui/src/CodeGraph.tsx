import { useEffect, useMemo, useRef, type CSSProperties, type KeyboardEvent } from 'react'
import { absoluteCodeDate, relativeCodeDate } from './codeFormat'
import {
  CODE_GRAPH_LANE_WIDTH,
  codeGraphLaneX,
  codeGraphPaths,
  isAgentCommit,
  layoutCodeGraph,
  parseCodeRefs,
  type CodeGraphCommit,
  type CodeGraphRow,
  type CodeRef,
} from './codeGraphLayout'
import { ProviderMark } from './ProviderMark'
import { useVirtualWindow } from './useVirtualWindow'

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

type CodeGraphLayout = 'compact' | 'table'

interface CodeGraphProps {
  graph: CodeGraphState | null
  error: string | null
  layout: CodeGraphLayout
  selectedSha: string | null
  returnLabel: string | null
  agentOnly: boolean
  branchOnly: boolean
  onToggleAgentOnly: () => void
  onToggleBranchOnly: () => void
  onSelect: (commit: CodeGraphCommit) => void
  onLoadMore: () => void
  onToggleExpanded: () => void
  onOpenConversation: (conversationId: string) => void
}

const ROW_HEIGHTS: Record<CodeGraphLayout, number> = { compact: 28, table: 34 }
const LANE_LIMITS: Record<CodeGraphLayout, number> = { compact: 8, table: 14 }
const AGENT_CELL_WIDTH = 20

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

function AgentCell({ commit, height, isHead }: { commit: CodeGraphCommit, height: number, isHead: boolean }) {
  return <svg className="code-graph-cell" width={AGENT_CELL_WIDTH} height={height} viewBox={`0 0 ${AGENT_CELL_WIDTH} ${height}`} aria-hidden="true">
    <circle cx={AGENT_CELL_WIDTH / 2} cy={height / 2} r={isHead ? 4.6 : 3.6} className={`code-graph-dot code-graph-lane-${commit.repoIndex % 8}${isHead ? ' is-head' : ''}`} />
  </svg>
}

export function CodeGraph({
  graph,
  error,
  layout,
  selectedSha,
  returnLabel,
  agentOnly,
  branchOnly,
  onToggleAgentOnly,
  onToggleBranchOnly,
  onSelect,
  onLoadMore,
  onToggleExpanded,
  onOpenConversation,
}: CodeGraphProps) {
  const commits = graph?.commits
  const focusCommits = graph?.focusCommits
  const filtered = agentOnly || branchOnly
  const visible = useMemo(
    () => ((branchOnly ? focusCommits : commits) ?? []).filter((commit) => !agentOnly || isAgentCommit(commit)),
    [commits, focusCommits, agentOnly, branchOnly],
  )
  const rows = useMemo(() => (filtered ? null : layoutCodeGraph(visible)), [visible, filtered])
  const agentCount = useMemo(() => ((branchOnly ? focusCommits : commits) ?? []).filter(isAgentCommit).length, [commits, focusCommits, branchOnly])
  const branchCount = focusCommits?.length ?? 0
  const rowHeight = ROW_HEIGHTS[layout]
  const listWindow = useVirtualWindow<HTMLDivElement>(visible.length, rowHeight)
  const { scrollToIndex } = listWindow
  const maxLanes = useMemo(() => (rows ?? []).reduce((max, row) => Math.max(max, row.laneCount), 1), [rows])
  const cellWidth = rows ? Math.min(maxLanes, LANE_LIMITS[layout]) * CODE_GRAPH_LANE_WIDTH + 4 : AGENT_CELL_WIDTH
  const indexBySha = useMemo(() => new Map(visible.map((commit, index) => [commit.sha, index])), [visible])

  const centeredKey = useRef<string | null>(null)
  const centerKey = graph ? `${graph.key}\n${layout}\n${agentOnly}\n${branchOnly}` : null
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
    const cell = row
      ? <GraphCell row={row} height={rowHeight} width={cellWidth} isHead={isHead} />
      : <AgentCell commit={commit} height={rowHeight} isHead={isHead} />

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
    {graph ? <div className="code-graph-filters" role="group" aria-label="Filtrer le graphe">
      {branchCount > 0 ? <button
        type="button"
        className={`code-filter-toggle${branchOnly ? ' is-active' : ''}`}
        aria-pressed={branchOnly}
        title="N’afficher que les commits d’avance sur la branche de base"
        onClick={onToggleBranchOnly}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><g stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"><circle cx="4.5" cy="3.5" r="1.5" /><circle cx="4.5" cy="12.5" r="1.5" /><circle cx="11.5" cy="5.5" r="1.5" /><path d="M4.5 5v6M11.5 7c0 3-7 2-7 4" /></g></svg>
        <span>Branche</span>
        <span className="code-filter-count">{branchCount}</span>
      </button> : null}
      <button
        type="button"
        className={`code-filter-toggle${agentOnly ? ' is-active' : ''}`}
        aria-pressed={agentOnly}
        title="N’afficher que les commits produits par un agent ou une conversation"
        onClick={onToggleAgentOnly}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 1.5 9.4 6.6 14.5 8 9.4 9.4 8 14.5 6.6 9.4 1.5 8l5.1-1.4Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
        <span>Agents</span>
        <span className="code-filter-count">{agentCount}</span>
      </button>
    </div> : null}
    {error ? <p className="code-empty-note is-error">{error}</p> : null}
    {!graph && !error ? <div className="code-skeleton" aria-label="Chargement du graphe" /> : null}
    {graph && !filtered && visible.length === 0 ? <p className="code-empty-note">Aucun commit dans ce dépôt.</p> : null}
    {graph && filtered && visible.length === 0 ? <p className="code-empty-note">Aucun commit ne correspond aux filtres parmi les commits chargés.</p> : null}
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
      {graph?.hasMore && !branchOnly ? <button type="button" className="code-graph-more" disabled={graph.loadingMore} onClick={onLoadMore}>
        {graph.loadingMore ? 'Chargement des commits suivants…' : 'Charger plus de commits'}
      </button> : null}
    </div>
  </div>
}
