import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  commitProjectGit,
  dispatchAllFlags,
  getProjectGit,
  getProjectGitDiff,
  getProjectGitFile,
  getProjectWorkingTreeDiff,
  getReview,
  listPresets,
  listProjectReviews,
  startReview,
} from './api'
import { CorrectionConfigSelector } from './CorrectionConfigSelector'
import { DiffViewer } from './DiffViewer'
import { ReviewConfigSelector, reviewPreset } from './ReviewConfigSelector'
import type { ReviewSelection } from './ReviewConfigSelector'
import { readCorrectionSelection, writeCorrectionSelection } from './correctionConfig'
import type { CorrectionSelection } from './correctionConfig'
import type {
  Conversation,
  GitCommit,
  GitDirtyFile,
  GitFileStatus,
  GitSnapshot,
  Preset,
  Project,
  Provider,
  QuotaSnapshot,
  Review,
  ReviewFlag,
  ReviewStatusSnapshot,
} from './types'
import { isScanRunning } from './reviewStatus'

type Scope = 'dirty' | 'commits' | 'tree' | 'master' | 'branches'
type ViewMode = 'diff' | 'file'
type SearchMode = 'quick-open' | 'search'

interface GitViewProps {
  project: Project
  conversation: Conversation | null
  focusedReviewId?: string | null
  focusedFlagId?: string | null
  reviewStatus?: ReviewStatusSnapshot | null
  quotas: QuotaSnapshot
  onConversationSelect: (conversationId: string) => void
  onReviewSelected?: (reviewId: string) => void
  onConversationBack: () => void
}

interface DiffLine {
  text: string
  kind: 'add' | 'remove' | 'meta' | 'context'
  number: number | null
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : 'La vue Code est indisponible.' }
function shortSha(sha: string): string { return sha.slice(0, 8) }
function dateLabel(value: string): string { return new Date(value).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' }) }
function statusClass(status: GitFileStatus): string { return `code-status code-status-${status === '?' ? 'unknown' : status.toLowerCase()}` }
function diffForPath(diff: string, path: string | null): string { return path ? diff.split(/(?=^diff --git )/m).filter((chunk) => chunk.includes(` b/${path}\n`) || chunk.includes(` b/${path}`)).join('') : diff }

function diffLines(diff: string): DiffLine[] {
  let lineNumber = 0
  return diff.split('\n').filter((line, index, lines) => !(index === lines.length - 1 && line === '')).map((text) => {
    if (text.startsWith('@@')) { const match = text.match(/\+(\d+)/); if (match) lineNumber = Number(match[1]) - 1; return { text, kind: 'meta', number: null } }
    if (text.startsWith('+++') || text.startsWith('---') || text.startsWith('diff ') || text.startsWith('index ')) return { text, kind: 'meta', number: null }
    if (text.startsWith('+')) { lineNumber += 1; return { text, kind: 'add', number: lineNumber } }
    if (text.startsWith('-')) return { text, kind: 'remove', number: null }
    if (text.startsWith(' ')) { lineNumber += 1; return { text, kind: 'context', number: lineNumber } }
    return { text, kind: 'context', number: null }
  })
}

function fileLines(content: string): Array<{ number: number, text: string }> {
  return content.split('\n').map((text, index) => ({ number: index + 1, text })).filter((line, index, lines) => !(index === lines.length - 1 && line.text === '' && lines.length > 1))
}

function buildTree(paths: string[]): Array<{ name: string, path: string, depth: number, directory: boolean }> {
  const directories = new Set<string>()
  for (const path of paths) { const parts = path.split('/'); for (let index = 1; index < parts.length; index += 1) directories.add(parts.slice(0, index).join('/')) }
  const result: Array<{ name: string, path: string, depth: number, directory: boolean }> = []
  for (const path of [...directories, ...paths].sort((left, right) => left.localeCompare(right))) {
    if (result.some((entry) => entry.path === path)) continue
    const parts = path.split('/')
    result.push({ name: parts.at(-1) ?? path, path, depth: parts.length - 1, directory: directories.has(path) })
  }
  return result
}

function scopeTag(scope: Scope): { label: string, className: string } {
  if (scope === 'dirty') return { label: 'hors relecture', className: 'is-dirty' }
  if (scope === 'commits') return { label: 'zone du Gardien', className: 'is-committed' }
  if (scope === 'tree') return { label: 'navigation', className: 'is-neutral' }
  return { label: 'lecture seule', className: 'is-neutral' }
}
function scopeTitle(scope: Scope, branch: string | null): string { return scope === 'dirty' ? 'Non commité' : scope === 'commits' ? `Commits de ${branch ?? 'la branche'}` : scope === 'tree' ? 'Arborescence' : scope === 'master' ? 'origin/master' : 'Branches et worktrees' }
function statusFile(path: string, dirtyFiles: GitDirtyFile[]): GitDirtyFile | undefined { return dirtyFiles.find((file) => file.path === path) }

function CodeSwitch({ dirtyCount, onConversationBack }: { dirtyCount: number, onConversationBack: () => void }) {
  return <div className="code-switch" role="tablist" aria-label="Surface de travail">
    <span className="code-switch-thumb" aria-hidden="true" />
    <button type="button" role="tab" aria-selected={false} onClick={onConversationBack}>Conversation</button>
    <button type="button" role="tab" aria-selected className="is-active">Code{dirtyCount > 0 ? <span className="code-switch-badge">{dirtyCount}</span> : null}</button>
  </div>
}

function CodeRail({ scope, snapshot, onScopeChange }: { scope: Scope, snapshot: GitSnapshot | null, onScopeChange: (scope: Scope) => void }) {
  const dirtyCount = snapshot?.dirtyFiles?.length ?? 0
  const commitCount = snapshot?.branchCommitShas?.length ?? 0
  const branchCount = snapshot?.branches.filter((branch) => !branch.remote).length ?? 0
  const items: Array<{ scope: Scope, label: string, count: string, tone: string, square?: boolean }> = [
    { scope: 'dirty', label: 'Non commité', count: String(dirtyCount), tone: 'dirty' },
    { scope: 'commits', label: 'Commits · relus', count: String(commitCount), tone: 'ok' },
    { scope: 'tree', label: 'Arborescence', count: '⌘P', tone: 'accent' },
    { scope: 'master', label: 'origin/master', count: `+${snapshot?.behind ?? 0}`, tone: 'neutral', square: true },
    { scope: 'branches', label: 'Autres branches', count: String(branchCount), tone: 'neutral', square: true },
  ]
  return <aside className="code-rail">
    <div className="code-rail-branch"><span className="code-branch-mark" aria-hidden="true">⑂</span><strong>{snapshot?.currentBranch ?? 'HEAD détachée'}</strong><span className="code-branch-distance">+{snapshot?.ahead ?? 0} −{snapshot?.behind ?? 0}</span></div>
    <nav aria-label="Portée de la vue Code">{items.map((item, index) => <div key={item.scope}>{index === 3 ? <p className="code-rail-heading">Références · lecture seule</p> : null}<button type="button" className={`code-rail-item${scope === item.scope ? ' is-active' : ''}`} aria-current={scope === item.scope ? 'page' : undefined} onClick={() => onScopeChange(item.scope)}><span className={`code-rail-dot is-${item.tone}${item.square ? ' is-square' : ''}`} aria-hidden="true" /><span>{item.label}</span><strong>{item.count}</strong></button></div>)}</nav>
    <div className="code-rail-footer"><p className="code-guardian-note"><span aria-hidden="true">·</span> Le Gardien ne relit que les commits de cette branche.</p><div className="code-escape-actions"><button type="button" disabled>VS Code</button><button type="button" disabled>Terminal</button></div></div>
  </aside>
}

function CommitBar({ files, selected, message, busy, onSelectAll, onMessageChange, onCommit, onCommitOnly }: { files: GitDirtyFile[], selected: Set<string>, message: string, busy: boolean, onSelectAll: (selectAll: boolean) => void, onMessageChange: (value: string) => void, onCommit: () => void, onCommitOnly: () => void }) {
  const selectedCount = files.filter((file) => selected.has(file.path)).length
  const allSelected = files.length > 0 && selectedCount === files.length
  return <div className="commit-bar"><div className="commit-bar-selection"><button type="button" className="commit-select-all" onClick={() => onSelectAll(!allSelected)}>{allSelected ? 'Tout désélectionner' : 'Tout sélectionner'}</button><span>{selectedCount} / {files.length} fichiers</span></div><div className="commit-message"><span aria-hidden="true">✦</span><input value={message} onChange={(event) => onMessageChange(event.target.value)} aria-label="Message du commit" /></div><button type="button" className="commit-primary" onClick={onCommit} disabled={busy || selectedCount === 0 || message.trim() === ''}>◈ Committer et faire relire</button><button type="button" className="commit-secondary" onClick={onCommitOnly} disabled={busy || selectedCount === 0 || message.trim() === ''}>Committer seulement <span>{selectedCount} / {files.length}</span></button><p>Sans relecture, le commit part avec un bouclier éteint : relisable plus tard depuis « Commits ».</p></div>
}

function DirtyFileList({ files, selected, selectedFile, onToggle, onSelect }: { files: GitDirtyFile[], selected: Set<string>, selectedFile: string | null, onToggle: (path: string) => void, onSelect: (path: string) => void }) {
  return <div className="code-dirty-files">{files.length === 0 ? <p className="code-empty-inline">Le worktree est propre. Les prochains commits apparaîtront ici.</p> : files.map((file) => <div key={file.path} className={`code-dirty-file${selectedFile === file.path ? ' is-selected' : ''}`}><input type="checkbox" checked={selected.has(file.path)} onChange={() => onToggle(file.path)} aria-label={`Inclure ${file.path} dans le commit`} /><button type="button" className="code-dirty-file-open" onClick={() => onSelect(file.path)}><span className={statusClass(file.status)}>{file.status}</span><span className="code-file-path" title={file.path}>{file.path}</span><span className="code-file-stat code-file-stat-add">+{file.added}</span><span className="code-file-stat code-file-stat-remove">−{file.removed}</span></button></div>)}</div>
}

function RefPicker({ refName, snapshot, onChange }: { refName: string, snapshot: GitSnapshot, onChange: (ref: string) => void }) {
  const refs = ['worktree', ...snapshot.branches.filter((branch) => branch.remote || !branch.current).map((branch) => branch.name)]
  return <div className="code-ref-picker" aria-label="Référence du fichier"><span>lire à</span>{refs.slice(0, 4).map((ref) => <button type="button" key={ref} className={`${refName === ref ? 'is-active ' : ''}${ref === 'worktree' ? 'is-worktree' : ''}`} onClick={() => onChange(ref)}>{ref === 'worktree' ? 'worktree' : ref.replace(/^origin\//, '')}</button>)}</div>
}

function FileTree({ snapshot, selectedFile, dirtyFiles, onSelect }: { snapshot: GitSnapshot, selectedFile: string | null, dirtyFiles: GitDirtyFile[], onSelect: (path: string) => void }) {
  return <div className="code-tree-list">{buildTree(snapshot.filePaths ?? []).map((entry) => { const file = statusFile(entry.path, dirtyFiles); return <button type="button" key={entry.path} className={`code-tree-row code-tree-depth-${Math.min(entry.depth, 8)}${selectedFile === entry.path ? ' is-selected' : ''}${entry.directory ? ' is-directory' : ''}`} onClick={() => !entry.directory && onSelect(entry.path)} disabled={entry.directory}><span className="code-tree-caret" aria-hidden="true">{entry.directory ? '▾' : '·'}</span><span className="code-tree-name">{entry.name}</span>{file ? <span className={statusClass(file.status)}>{file.status}</span> : null}</button> })}</div>
}

function QuickOpen({ mode, query, paths, dirtyFiles, onQuery, onClose, onSelect }: { mode: SearchMode, query: string, paths: string[], dirtyFiles: GitDirtyFile[], onQuery: (value: string) => void, onClose: () => void, onSelect: (path: string) => void }) {
  const filtered = paths.filter((path) => path.toLowerCase().includes(query.toLowerCase())).sort((left, right) => Number(dirtyFiles.some((file) => file.path === right)) - Number(dirtyFiles.some((file) => file.path === left)) || left.localeCompare(right)).slice(0, 20)
  return <div className="code-overlay-backdrop" role="presentation" onMouseDown={onClose}><section className="code-overlay" role="dialog" aria-modal="true" aria-label={mode === 'quick-open' ? 'Ouvrir un fichier' : 'Rechercher dans les fichiers'} onMouseDown={(event) => event.stopPropagation()}><div className="code-overlay-input"><span aria-hidden="true">{mode === 'quick-open' ? '⌕' : '⌗'}</span><input autoFocus value={query} onChange={(event) => onQuery(event.target.value)} placeholder={mode === 'quick-open' ? 'Aller à un fichier…' : 'Chercher dans les fichiers…'} /><kbd>{mode === 'quick-open' ? 'testcs · worktree' : 'worktree · branche · master'}</kbd></div><div className="code-overlay-results">{filtered.length === 0 ? <p className="code-empty-inline">Aucun fichier correspondant.</p> : filtered.map((path) => <button type="button" key={path} onClick={() => onSelect(path)}><span className={statusClass(dirtyFiles.find((file) => file.path === path)?.status ?? 'M')}>{dirtyFiles.find((file) => file.path === path)?.status ?? '·'}</span><strong>{path.split('/').at(-1)}</strong><span>{path.slice(0, Math.max(0, path.length - (path.split('/').at(-1)?.length ?? path.length)))}</span>{dirtyFiles.some((file) => file.path === path) ? <em>modifié</em> : null}</button>)}</div><footer><span>↵ ouvrir</span><span>⇥ changer de référence</span><span>Esc fermer</span></footer></section></div>
}

function CodeFilePanel({ snapshot, selectedFile, refName, viewMode, content, diff, onRefChange, onViewModeChange }: { snapshot: GitSnapshot, selectedFile: string | null, refName: string, viewMode: ViewMode, content: string | null, diff: string, onRefChange: (ref: string) => void, onViewModeChange: (mode: ViewMode) => void }) {
  const currentDiff = diffForPath(diff, selectedFile)
  return <section className="code-file-panel"><header className="code-file-header"><div className="code-file-title"><strong>{selectedFile ?? (refName === 'worktree' ? 'Changements du worktree' : 'Sélectionne un fichier')}</strong>{selectedFile ? <span> · {refName}</span> : null}</div>{selectedFile ? <RefPicker refName={refName} snapshot={snapshot} onChange={onRefChange} /> : null}{selectedFile ? <div className="code-mode-switch" role="group" aria-label="Mode d'affichage"><button type="button" className={viewMode === 'diff' ? 'is-active' : ''} onClick={() => onViewModeChange('diff')}>Diff</button><button type="button" className={viewMode === 'file' ? 'is-active' : ''} onClick={() => onViewModeChange('file')}>Fichier entier</button></div> : null}</header>{selectedFile && refName === 'worktree' ? <div className="code-context-banner is-worktree">Ta version en cours — écrite par l’agent, jamais commitée. Le Gardien ne la relit pas.</div> : null}{selectedFile && refName !== 'worktree' ? <div className="code-context-banner">Version de <strong>{refName}</strong> — lecture seule.</div> : null}{viewMode === 'file' && selectedFile ? <div className="code-source" role="region" aria-label={`Contenu de ${selectedFile}`}>{content === null ? <p className="code-empty-inline">Chargement du fichier…</p> : fileLines(content).map((line) => <div key={line.number} className="code-source-line"><span>{line.number}</span><code>{line.text || ' '}</code></div>)}</div> : <div className="code-diff" role="region" aria-label="Diff Git">{currentDiff ? diffLines(currentDiff).map((line, index) => <div key={`${index}-${line.text}`} className={`code-diff-line is-${line.kind}`}><span>{line.number ?? ''}</span><code>{line.text || ' '}</code></div>) : <p className="code-empty-panel">Aucun diff à afficher pour cette sélection.</p>}</div>}</section>
}

function CommitList({ commits, selectedSha, onSelect, onReview }: { commits: GitCommit[], selectedSha: string | null, onSelect: (sha: string) => void, onReview: (commit: GitCommit) => void }) {
  return <div className="code-commit-list">{commits.length === 0 ? <p className="code-empty-panel">Aucun commit propre à cette branche depuis sa base.</p> : commits.map((commit) => { const reviewed = commit.guardian.length > 0; const latest = commit.guardian.at(-1); const issues = latest ? latest.red + latest.orange + latest.grey : 0; return <button type="button" key={commit.sha} className={`code-commit-row${selectedSha === commit.sha ? ' is-selected' : ''}`} onClick={() => onSelect(commit.sha)}><span className={`code-shield${reviewed ? ' is-sealed' : ''}`} aria-label={reviewed ? 'Commit relu' : 'Commit non relu'}>{reviewed ? '◈' : '◇'}</span><code>{shortSha(commit.sha)}</code><strong>{commit.subject}</strong><span className={`code-guardian-state ${reviewed ? (issues > 0 ? 'is-warning' : 'is-sealed') : 'is-unreviewed'}`}>{reviewed ? (issues > 0 ? `${issues} signalement${issues > 1 ? 's' : ''}` : 'scellé') : 'non relu'}</span><span className="code-commit-date">{dateLabel(commit.authoredAt)}</span><span className="code-commit-action">{reviewed ? 'Voir' : <span role="button" tabIndex={0} onClick={(event) => { event.stopPropagation(); onReview(commit) }}>Faire relire</span>}</span></button> })}</div>
}

export function GitView({ project, conversation, focusedReviewId = null, focusedFlagId = null, reviewStatus = null, quotas, onConversationSelect: _onConversationSelect, onReviewSelected, onConversationBack }: GitViewProps) {
  const [snapshot, setSnapshot] = useState<GitSnapshot | null>(null)
  const [scope, setScope] = useState<Scope>('dirty')
  const [diff, setDiff] = useState('')
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [selectedCommitSha, setSelectedCommitSha] = useState<string | null>(null)
  const [refName, setRefName] = useState('worktree')
  const [viewMode, setViewMode] = useState<ViewMode>('diff')
  const [fileContent, setFileContent] = useState<string | null>(null)
  const [selection, setSelection] = useState<Set<string>>(new Set())
  const [commitMessage, setCommitMessage] = useState('Mise à jour des fichiers sélectionnés')
  const [commitBusy, setCommitBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [overlay, setOverlay] = useState<SearchMode | null>(null)
  const [overlayQuery, setOverlayQuery] = useState('')
  const [reviews, setReviews] = useState<Review[]>([])
  const [selectedReviewId, setSelectedReviewId] = useState<string | null>(focusedReviewId)
  const [reviewBusy, setReviewBusy] = useState(false)
  const [presets, setPresets] = useState<Preset[]>([])
  const [presetId, setPresetId] = useState(project.default_review_preset_id === undefined ? project.default_preset_id ?? '' : project.default_review_preset_id ?? '')
  const [provider, setProvider] = useState<Provider>(conversation?.provider ?? 'codex')
  const [model, setModel] = useState(conversation?.provider === 'claude' ? 'opus' : 'gpt-5.6-sol')
  const [effort, setEffort] = useState('high')
  const [speed, setSpeed] = useState<'standard' | 'fast'>('standard')
  const [correction, setCorrection] = useState<CorrectionSelection>(() => conversation ? readCorrectionSelection(conversation) : { presetId: '', provider: 'codex', model: 'gpt-5.6-luna', effort: 'xhigh', speed: 'fast' })
  const [isDispatching, setIsDispatching] = useState(false)

  const dirtyFiles = snapshot?.dirtyFiles ?? []
  const filePaths = snapshot?.filePaths ?? []
  const branchCommits = useMemo(() => { if (!snapshot) return []; const ids = snapshot.branchCommitShas ?? snapshot.commits.map((commit) => commit.sha); return ids.map((sha) => snapshot.commits.find((commit) => commit.sha === sha)).filter((commit): commit is GitCommit => commit !== undefined) }, [snapshot])
  const selectedCommit = branchCommits.find((commit) => commit.sha === selectedCommitSha) ?? branchCommits[0] ?? null
  const selectedReview = reviews.find((review) => review.id === selectedReviewId) ?? null
  const selectedFlags = selectedReview?.flags ?? []
  const openFlags = selectedFlags.filter((flag) => flag.status === 'open' || flag.status === 'countered')

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const [loadedSnapshot, loadedReviews] = await Promise.all([getProjectGit(project.id, conversation?.id, signal), listProjectReviews(project.id, signal)])
    if (signal?.aborted) return
    setSnapshot(loadedSnapshot)
    setReviews(conversation ? loadedReviews.filter((review) => review.conversation_id === conversation.id) : loadedReviews)
    setSelectedReviewId((current) => focusedReviewId ?? current ?? loadedReviews.find((review) => review.conversation_id === conversation?.id)?.id ?? null)
    setScope((current) => current === 'dirty' && (loadedSnapshot.dirtyFiles?.length ?? 0) === 0 ? 'commits' : current)
    const nextSelection = new Set((loadedSnapshot.dirtyFiles ?? []).filter((file) => file.status !== '?').map((file) => file.path))
    setSelection((current) => current.size === 0 ? nextSelection : new Set([...current].filter((path) => loadedSnapshot.dirtyFiles?.some((file) => file.path === path))))
    setSelectedCommitSha((current) => current ?? loadedSnapshot.branchCommitShas?.[0] ?? loadedSnapshot.commits[0]?.sha ?? null)
  }, [conversation, focusedReviewId, project.id])

  useEffect(() => { const controller = new AbortController(); void refresh(controller.signal).catch((reason) => { if (!controller.signal.aborted) setError(errorMessage(reason)) }); return () => controller.abort() }, [refresh])
  useEffect(() => { const controller = new AbortController(); void listPresets(controller.signal).then((loaded) => { if (controller.signal.aborted) return; setPresets(loaded); const defaultId = project.default_review_preset_id === undefined ? project.default_preset_id : project.default_review_preset_id; const source = loaded.find((preset) => preset.id === defaultId); const preset = source ? reviewPreset(source) : null; if (preset) { setPresetId(preset.id); setProvider(preset.provider); setModel(preset.model); setEffort(preset.effort ?? 'high'); setSpeed(preset.provider === 'codex' ? (preset.speed ?? 'standard') : 'standard') } }).catch(() => {}); return () => controller.abort() }, [project.default_preset_id, project.default_review_preset_id])
  useEffect(() => { if (conversation) setCorrection(readCorrectionSelection(conversation)) }, [conversation])
  useEffect(() => { const controller = new AbortController(); if (scope === 'dirty') void getProjectWorkingTreeDiff(project.id, conversation?.id, controller.signal).then((loaded) => { if (!controller.signal.aborted) setDiff(loaded.diff) }).catch((reason) => { if (!controller.signal.aborted) setError(errorMessage(reason)) }); else if (scope === 'commits' && selectedCommit) void getProjectGitDiff(project.id, selectedCommit.parents[0] ?? `${selectedCommit.sha}^`, selectedCommit.sha, conversation?.id, controller.signal).then((loaded) => { if (!controller.signal.aborted) setDiff(loaded.diff) }).catch((reason) => { if (!controller.signal.aborted) setError(errorMessage(reason)) }); else setDiff(''); return () => controller.abort() }, [conversation?.id, project.id, scope, selectedCommit?.sha, selectedCommit?.parents])
  useEffect(() => { if (!selectedFile || viewMode !== 'file' || !snapshot) return; const controller = new AbortController(); setFileContent(null); void getProjectGitFile(project.id, selectedFile, refName, conversation?.id, controller.signal).then((loaded) => { if (!controller.signal.aborted) setFileContent(loaded.content) }).catch((reason) => { if (!controller.signal.aborted) setError(errorMessage(reason)) }); return () => controller.abort() }, [conversation?.id, project.id, refName, selectedFile, snapshot, viewMode])
  useEffect(() => { if (!selectedReview || selectedReview.status !== 'running') return; const timer = window.setInterval(() => { void getReview(selectedReview.id).then((updated) => setReviews((current) => current.map((review) => review.id === updated.id ? updated : review))).catch(() => {}) }, 1_500); return () => window.clearInterval(timer) }, [selectedReview?.id, selectedReview?.status])
  useEffect(() => { function onKeyDown(event: KeyboardEvent) { const target = event.target as HTMLElement | null; if (target?.matches('input, textarea, select, [contenteditable="true"]')) return; if (event.key === 'Escape') { setOverlay(null); return } if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'p') { event.preventDefault(); setOverlay('quick-open'); setOverlayQuery(''); return } if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'f') { event.preventDefault(); setOverlay('search'); setOverlayQuery(''); return } if ((event.metaKey || event.ctrlKey) && event.key === '1') { event.preventDefault(); onConversationBack(); return } if ((event.metaKey || event.ctrlKey) && event.key === '2') { event.preventDefault(); setScope('dirty') } } window.addEventListener('keydown', onKeyDown); return () => window.removeEventListener('keydown', onKeyDown) }, [onConversationBack])

  function selectFile(path: string) { setSelectedFile(path); setFileContent(null); setViewMode(scope === 'tree' ? 'file' : 'diff'); if (scope === 'tree') setRefName('worktree') }
  function changeScope(next: Scope) { setScope(next); setError(null); if (next === 'tree') { setViewMode('file'); setSelectedFile((current) => current ?? filePaths[0] ?? null); setRefName('worktree') } if (next === 'commits') setSelectedCommitSha((current) => current ?? branchCommits[0]?.sha ?? null); if (next !== 'tree') setViewMode('diff') }
  function toggleSelection(path: string) { setSelection((current) => { const next = new Set(current); if (next.has(path)) next.delete(path); else next.add(path); return next }) }
  function selectReviewConfig(next: ReviewSelection) { setPresetId(next.presetId); setProvider(next.provider); setModel(next.model); setEffort(next.effort); setSpeed(next.speed) }
  function selectCorrectionConfig(next: CorrectionSelection) { setCorrection(next); if (conversation) writeCorrectionSelection(conversation.id, next) }

  async function reviewCommit(commit: GitCommit) { if (!conversation || reviewBusy) return; setReviewBusy(true); setError(null); try { const review = await startReview({ conversationId: conversation.id, scope: 'comparison', gitRefBase: commit.parents[0] ?? `${commit.sha}^`, gitRefHead: commit.sha, presetId: presetId || null, reviewProvider: provider, reviewModel: model, reviewEffort: effort, reviewSpeed: speed }); setReviews((current) => [review, ...current.filter((item) => item.id !== review.id)]); setSelectedReviewId(review.id); onReviewSelected?.(review.id) } catch (reason) { setError(errorMessage(reason)) } finally { setReviewBusy(false) } }
  async function commit(withReview: boolean) { if (!conversation || commitBusy) return; const paths = dirtyFiles.filter((file) => selection.has(file.path)).map((file) => file.path); if (paths.length === 0 || commitMessage.trim() === '') return; setCommitBusy(true); setError(null); try { const result = await commitProjectGit(project.id, { conversationId: conversation.id, paths, message: commitMessage }); await refresh(); setScope('commits'); setSelectedCommitSha(result.sha); if (withReview) { const review = await startReview({ conversationId: conversation.id, scope: 'comparison', gitRefBase: `${result.sha}^`, gitRefHead: result.sha, presetId: presetId || null, reviewProvider: provider, reviewModel: model, reviewEffort: effort, reviewSpeed: speed }); setReviews((current) => [review, ...current.filter((item) => item.id !== review.id)]); setSelectedReviewId(review.id); onReviewSelected?.(review.id) } } catch (reason) { setError(errorMessage(reason)) } finally { setCommitBusy(false) } }
  async function dispatchOpen() { if (!selectedReview || isDispatching || openFlags.length === 0) return; setIsDispatching(true); setError(null); const previous = selectedReview; setReviews((current) => current.map((review) => review.id === selectedReview.id ? { ...review, flags: review.flags.map((flag) => openFlags.some((item) => item.id === flag.id) ? { ...flag, status: 'agent_running' } : flag) } : review)); try { await dispatchAllFlags(selectedReview.id, ['red', 'orange', 'grey'], correction); const updated = await getReview(selectedReview.id); setReviews((current) => current.map((review) => review.id === updated.id ? updated : review)) } catch (reason) { setReviews((current) => current.map((review) => review.id === previous.id ? previous : review)); setError(errorMessage(reason)) } finally { setIsDispatching(false) } }
  function updateFlag(updated: ReviewFlag) { setReviews((current) => current.map((review) => review.id === updated.review_id ? { ...review, flags: review.flags.map((flag) => flag.id === updated.id ? updated : flag) } : review)) }

  const tag = scopeTag(scope)
  const selectedReviewDiff = selectedReview?.diff_text || diff
  const fallbackSnapshot: GitSnapshot = { branches: [], commits: [], worktrees: [], head: null, headParents: [], currentBranch: null }

  return <div className="git-workspace code-workspace">
    <header className="code-header"><div className="code-header-title"><strong>{conversation?.title ?? project.name}</strong><span>{snapshot?.currentBranch ?? 'HEAD détachée'} · worktree de cette conversation</span></div><CodeSwitch dirtyCount={dirtyFiles.length} onConversationBack={onConversationBack} /><div className="code-header-actions"><button type="button" onClick={() => { setOverlay('quick-open'); setOverlayQuery('') }}>Aller à un fichier <kbd>⌘P</kbd></button><button type="button" onClick={() => { setOverlay('search'); setOverlayQuery('') }}>Rechercher <kbd>⇧⌘F</kbd></button></div></header>
    {error ? <div className="git-error" role="alert">{error}</div> : null}
    <div className="code-layout"><CodeRail scope={scope} snapshot={snapshot} onScopeChange={changeScope} /><main className="code-main" aria-label="Vue Code">
      <header className="code-panel-header"><div><h1>{scopeTitle(scope, snapshot?.currentBranch ?? null)}</h1><span className={`code-scope-tag ${tag.className}`}>{tag.label}</span><code>{scope === 'dirty' ? `${dirtyFiles.length} fichier${dirtyFiles.length > 1 ? 's' : ''}` : scope === 'commits' ? `${branchCommits.length} commit${branchCommits.length > 1 ? 's' : ''}` : 'lecture Git'}</code></div>{scope === 'commits' ? <div className="code-review-tools"><span>{reviewStatus?.running ? `Zone ${reviewStatus.running.zoneDone}/${reviewStatus.running.zoneTotal}` : 'Review par commit'}</span><ReviewConfigSelector value={{ presetId, provider, model, effort, speed }} presets={presets} quotas={quotas} busy={reviewBusy || isScanRunning(reviewStatus)} placement="bottom" submenuPlacement="left" onChange={selectReviewConfig} /></div> : null}</header>
      {scope === 'dirty' ? <section className="code-dirty-layout"><aside><DirtyFileList files={dirtyFiles} selected={selection} selectedFile={selectedFile} onToggle={toggleSelection} onSelect={selectFile} /><CommitBar files={dirtyFiles} selected={selection} message={commitMessage} busy={commitBusy} onSelectAll={(selectAll) => setSelection(selectAll ? new Set(dirtyFiles.map((file) => file.path)) : new Set())} onMessageChange={setCommitMessage} onCommit={() => void commit(true)} onCommitOnly={() => void commit(false)} /></aside><CodeFilePanel snapshot={snapshot ?? fallbackSnapshot} selectedFile={selectedFile} refName={refName} viewMode={viewMode} content={fileContent} diff={diff} onRefChange={(next) => { setRefName(next); setViewMode('file') }} onViewModeChange={setViewMode} /></section> : null}
      {scope === 'commits' ? <section className="code-commits-layout"><CommitList commits={branchCommits} selectedSha={selectedCommitSha} onSelect={(sha) => { setSelectedCommitSha(sha); setSelectedReviewId(null) }} onReview={(commit) => void reviewCommit(commit)} /><div className="code-commit-detail">{selectedReview && selectedReviewDiff ? <><header className="code-commit-detail-header"><strong>{selectedReview.status === 'running' ? 'Review en cours…' : 'Diff du commit'}</strong><div className="code-review-actions">{selectedReview.flags.length > 0 ? <CorrectionConfigSelector value={correction} presets={presets} quotas={quotas} busy={isDispatching} placement="bottom" submenuPlacement="left" onChange={selectCorrectionConfig} /> : null}<button type="button" onClick={() => void dispatchOpen()} disabled={isDispatching || openFlags.length === 0}>{isDispatching ? 'Lancement…' : `Corriger les ${openFlags.length} ouverts`}</button></div></header><DiffViewer diff={selectedReviewDiff} flags={selectedFlags} selectedFlagId={focusedFlagId} label="Diff du commit" onFlagUpdated={updateFlag} correction={correction} /></> : <CodeFilePanel snapshot={snapshot ?? fallbackSnapshot} selectedFile={selectedFile} refName={refName} viewMode={viewMode} content={fileContent} diff={diff} onRefChange={(next) => { setRefName(next); setViewMode('file') }} onViewModeChange={setViewMode} />}</div></section> : null}
      {scope === 'tree' && snapshot ? <section className="code-tree-layout"><aside><FileTree snapshot={snapshot} selectedFile={selectedFile} dirtyFiles={dirtyFiles} onSelect={selectFile} /></aside><CodeFilePanel snapshot={snapshot} selectedFile={selectedFile} refName={refName} viewMode="file" content={fileContent} diff={diff} onRefChange={(next) => { setRefName(next); setViewMode('file') }} onViewModeChange={setViewMode} /></section> : null}
      {scope === 'master' ? <section className="code-reference-panel"><div className="code-reference-card"><h2>Arrivé sur origin/master depuis ton point de départ</h2>{(snapshot?.incoming ?? []).length === 0 ? <p className="code-empty-inline">Aucun commit entrant.</p> : (snapshot?.incoming ?? []).map((commit) => <div className="code-incoming-row" key={commit.sha}><code>{shortSha(commit.sha)}</code><strong>{commit.subject}</strong><span>{commit.author} · {dateLabel(commit.authoredAt)}</span></div>)}</div>{(snapshot?.conflicts ?? []).length > 0 ? <div className="code-conflict-card"><h2>Fichiers touchés des deux côtés — conflit probable</h2>{(snapshot?.conflicts ?? []).map((conflict) => <code key={conflict.path}>{conflict.path}</code>)}</div> : null}<div className="code-rebase-row"><button type="button" disabled={(snapshot?.dirtyFiles?.length ?? 0) > 0}>Rebaser {snapshot?.currentBranch ?? 'la branche'} sur master</button>{(snapshot?.dirtyFiles?.length ?? 0) > 0 ? <span>Impossible tant qu’il reste du non commité.</span> : null}</div></section> : null}
      {scope === 'branches' && snapshot ? <section className="code-branches-panel"><div className="code-branches-head"><span>Branche</span><span>Référence</span><span>Worktree</span><span>État</span></div>{snapshot.branches.filter((branch) => !branch.remote).map((branch) => { const tree = snapshot.worktrees.find((worktree) => worktree.branch === branch.name); const isCurrent = branch.current; return <div className="code-branch-row" key={branch.name}><strong>{branch.name}</strong><code>{shortSha(branch.sha)}</code><span>{tree ? tree.path : '—'}</span><em className={isCurrent && dirtyFiles.length > 0 ? 'is-dirty' : 'is-clean'}>{isCurrent && dirtyFiles.length > 0 ? `${dirtyFiles.length} non commité${dirtyFiles.length > 1 ? 's' : ''}` : 'propre'}</em></div> })}</section> : null}
    </main></div>
    {overlay ? <QuickOpen mode={overlay} query={overlayQuery} paths={filePaths} dirtyFiles={dirtyFiles} onQuery={setOverlayQuery} onClose={() => setOverlay(null)} onSelect={(path) => { setOverlay(null); setScope('tree'); setSelectedFile(path); setViewMode('file'); setRefName('worktree') }} /> : null}
  </div>
}
