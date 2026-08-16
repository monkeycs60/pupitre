import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  commitProjectGit,
  dispatchAllFlags,
  getConversationDiff,
  getProjectGit,
  getProjectGitDiff,
  listProjectReviews,
  startReview,
} from './api'
import { DiffViewer } from './DiffViewer'
import { diffForPath } from './reviewDiff'
import { buildFileTree } from './reviewFileTree'
import { isScanRunning } from './reviewStatus'
import { SurfaceSwitch } from './SurfaceSwitch'
import type {
  Conversation,
  GitCommit,
  GitDiff,
  GitSnapshot,
  Project,
  Review,
  ReviewFlag,
  ReviewSeverity,
  ReviewStatusSnapshot,
} from './types'
import type { FileEntry } from './reviewFileTree'

type Tab = 'changes' | 'history'

interface GitViewProps {
  project: Project
  conversation: Conversation | null
  focusedFlagId?: string | null
  reviewStatus?: ReviewStatusSnapshot | null
  onConversationBack: () => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'La vue Code est indisponible.'
}

function shortSha(sha: string): string {
  return sha.slice(0, 8)
}

function dateLabel(value: string): string {
  return new Date(value).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' })
}

function branchCommits(snapshot: GitSnapshot | null): GitCommit[] {
  if (!snapshot) return []
  const ids = snapshot.branchCommitShas ?? snapshot.commits.map((commit) => commit.sha)
  return ids
    .map((sha) => snapshot.commits.find((commit) => commit.sha === sha))
    .filter((commit): commit is GitCommit => commit !== undefined)
}

function FileBadges({ counts }: { counts: Record<ReviewSeverity, number> }) {
  if (counts.red === 0 && counts.orange === 0 && counts.grey === 0) return null
  return <span className="changes-file-badges">
    {counts.red > 0 ? <i className="is-red">{counts.red}</i> : null}
    {counts.orange > 0 ? <i className="is-orange">{counts.orange}</i> : null}
    {counts.grey > 0 ? <i className="is-grey">{counts.grey}</i> : null}
  </span>
}

function ChangedFileList({ files, selectedFile, onSelect }: {
  files: FileEntry[]
  selectedFile: string | null
  onSelect: (path: string | null) => void
}) {
  const totals = files.reduce((acc, file) => ({
    red: acc.red + file.counts.red,
    orange: acc.orange + file.counts.orange,
    grey: acc.grey + file.counts.grey,
  }), { red: 0, orange: 0, grey: 0 })

  return <nav className="changes-file-list" aria-label="Fichiers modifiés">
    <button type="button" className={selectedFile === null ? 'is-active' : ''} onClick={() => onSelect(null)}>
      <span>Tous les fichiers</span>
      <FileBadges counts={totals} />
    </button>
    {files.map((file) => (
      <button type="button" key={file.path} className={selectedFile === file.path ? 'is-active' : ''} onClick={() => onSelect(file.path)}>
        <span className="changes-file-path" title={file.path}>{file.path}</span>
        <FileBadges counts={file.counts} />
      </button>
    ))}
  </nav>
}

interface ChangesTabProps {
  project: Project
  conversation: Conversation
  live: GitDiff | null
  review: Review | null
  reviewStatus: ReviewStatusSnapshot | null
  focusedFlagId: string | null
  onFlagUpdated: (flag: ReviewFlag) => void
  onRefresh: () => void
}

function ChangesTab({ project, conversation, live, review, reviewStatus, focusedFlagId, onFlagUpdated, onRefresh }: ChangesTabProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [commitMessage, setCommitMessage] = useState('')
  const [filter, setFilter] = useState<'open' | 'all'>('open')
  const [selectedFile, setSelectedFile] = useState<string | null>(null)

  const diff = review?.diff_text ?? live?.diff ?? ''
  const flags = review?.flags ?? []
  const files = useMemo(() => buildFileTree(diff, flags), [diff, flags])
  const liveFiles = useMemo(() => live ? buildFileTree(live.diff, []).map((entry) => entry.path) : [], [live])
  const openFlags = flags.filter((flag) => flag.status === 'open' || flag.status === 'agent_running')
  const visibleFlags = filter === 'open' ? openFlags : flags
  const scopedDiff = diffForPath(diff, selectedFile)
  const stale = review !== null && live !== null && review.diff_text !== live.diff

  async function relire() {
    if (busy || isScanRunning(reviewStatus)) return
    setBusy(true); setError(null)
    try {
      await startReview({ conversationId: conversation.id, scope: 'worktree' })
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  async function correctOpen() {
    if (!review || openFlags.length === 0) return
    if (!window.confirm(`Lancer ${openFlags.length} correction${openFlags.length > 1 ? 's' : ''} ?`)) return
    setBusy(true); setError(null)
    try {
      await dispatchAllFlags(review.id, ['red', 'orange', 'grey'])
      onRefresh()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  async function commit() {
    if (busy || commitMessage.trim() === '' || liveFiles.length === 0) return
    setBusy(true); setError(null)
    try {
      await commitProjectGit(project.id, { conversationId: conversation.id, paths: liveFiles, message: commitMessage })
      setCommitMessage('')
      onRefresh()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  const relireLabel = isScanRunning(reviewStatus) && reviewStatus?.running
    ? `Zone ${reviewStatus.running.zoneDone}/${reviewStatus.running.zoneTotal}`
    : 'Relire'

  return <section className="changes-tab">
    <aside className="changes-sidebar">
      {stale ? <p className="changes-banner">Le worktree a changé depuis la relecture — <button type="button" onClick={() => void relire()}>Relire</button></p> : null}
      {!review && !stale ? <p className="changes-banner">Pas encore relu — <button type="button" onClick={() => void relire()}>Relire</button></p> : null}
      <ChangedFileList files={files} selectedFile={selectedFile} onSelect={setSelectedFile} />
      <div className="changes-commit">
        <input
          value={commitMessage}
          onChange={(event) => setCommitMessage(event.target.value)}
          placeholder="Message du commit"
          aria-label="Message du commit"
        />
        <button type="button" onClick={() => void commit()} disabled={busy || commitMessage.trim() === '' || liveFiles.length === 0}>Committer</button>
      </div>
    </aside>
    <div className="changes-main">
      <header className="changes-toolbar">
        <button type="button" onClick={() => void relire()} disabled={busy || isScanRunning(reviewStatus)}>{relireLabel}</button>
        <button type="button" onClick={() => void correctOpen()} disabled={busy || openFlags.length === 0}>Corriger les {openFlags.length} ouverts</button>
        <div className="changes-filter" role="group" aria-label="Filtrer les signalements">
          <button type="button" className={filter === 'open' ? 'is-active' : ''} onClick={() => setFilter('open')}>Ouverts</button>
          <button type="button" className={filter === 'all' ? 'is-active' : ''} onClick={() => setFilter('all')}>Tous</button>
        </div>
      </header>
      {error ? <p className="code-error" role="alert">{error}</p> : null}
      {scopedDiff
        ? <DiffViewer diff={scopedDiff} flags={visibleFlags} label="Diff de la conversation" selectedFlagId={focusedFlagId} onFlagUpdated={onFlagUpdated} />
        : <p className="changes-empty">Rien à afficher pour cette sélection.</p>}
    </div>
  </section>
}

interface HistoryTabProps {
  project: Project
  conversation: Conversation
  snapshot: GitSnapshot | null
  reviews: Review[]
  onReviewStarted: (review: Review) => void
}

function CommitList({ commits, selectedSha, onSelect, onReview }: {
  commits: GitCommit[]
  selectedSha: string | null
  onSelect: (sha: string) => void
  onReview: (commit: GitCommit) => void
}) {
  if (commits.length === 0) return <p className="code-empty-panel">Aucun commit propre à cette branche depuis sa base.</p>
  return <div className="code-commit-list">
    {commits.map((commit) => {
      const reviewed = commit.guardian.length > 0
      const latest = commit.guardian.at(-1)
      const issues = latest ? latest.red + latest.orange + latest.grey : 0
      return <button type="button" key={commit.sha} className={`code-commit-row${selectedSha === commit.sha ? ' is-selected' : ''}`} onClick={() => onSelect(commit.sha)}>
        <span className={`code-shield${reviewed ? ' is-sealed' : ''}`} aria-label={reviewed ? 'Commit relu' : 'Commit non relu'}>{reviewed ? '◈' : '◇'}</span>
        <code>{shortSha(commit.sha)}</code>
        <strong>{commit.subject}</strong>
        <span className={`code-guardian-state ${reviewed ? (issues > 0 ? 'is-warning' : 'is-sealed') : 'is-unreviewed'}`}>
          {reviewed ? (issues > 0 ? `${issues} signalement${issues > 1 ? 's' : ''}` : 'scellé') : 'non relu'}
        </span>
        <span className="code-commit-date">{dateLabel(commit.authoredAt)}</span>
        <span className="code-commit-action">
          {reviewed
            ? 'Voir'
            : <span role="button" tabIndex={0} onClick={(event) => { event.stopPropagation(); onReview(commit) }}>Faire relire</span>}
        </span>
      </button>
    })}
  </div>
}

function HistoryTab({ project, conversation, snapshot, reviews, onReviewStarted }: HistoryTabProps) {
  const [selectedSha, setSelectedSha] = useState<string | null>(null)
  const [detailDiff, setDetailDiff] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const commits = useMemo(() => branchCommits(snapshot), [snapshot])
  const selectedCommit = commits.find((commit) => commit.sha === selectedSha) ?? commits[0] ?? null
  const commitReview = selectedCommit
    ? reviews.find((review) => review.scope === 'comparison' && review.git_ref_head === selectedCommit.sha) ?? null
    : null

  useEffect(() => {
    if (!selectedCommit) { setDetailDiff(''); return }
    if (commitReview) { setDetailDiff(commitReview.diff_text); return }
    const controller = new AbortController()
    void getProjectGitDiff(project.id, selectedCommit.parents[0] ?? `${selectedCommit.sha}^`, selectedCommit.sha, conversation.id, controller.signal)
      .then((loaded) => { if (!controller.signal.aborted) setDetailDiff(loaded.diff) })
      .catch((reason) => { if (!controller.signal.aborted) setError(errorMessage(reason)) })
    return () => controller.abort()
  }, [project.id, conversation.id, selectedCommit, commitReview])

  async function reviewCommit(commit: GitCommit) {
    if (busy) return
    setBusy(true); setError(null)
    try {
      const review = await startReview({
        conversationId: conversation.id,
        scope: 'comparison',
        gitRefBase: commit.parents[0] ?? `${commit.sha}^`,
        gitRefHead: commit.sha,
      })
      onReviewStarted(review)
      setSelectedSha(commit.sha)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  return <section className="history-tab">
    <CommitList commits={commits} selectedSha={selectedCommit?.sha ?? null} onSelect={setSelectedSha} onReview={(commit) => void reviewCommit(commit)} />
    <div className="history-detail">
      {error ? <p className="code-error" role="alert">{error}</p> : null}
      {selectedCommit ? (
        <>
          <header className="code-commit-detail-header">
            <strong>{selectedCommit.subject}</strong>
          </header>
          {detailDiff
            ? <DiffViewer diff={detailDiff} flags={commitReview?.flags ?? []} label={`Diff du commit ${selectedCommit.sha}`} />
            : <p className="changes-empty">Chargement du diff…</p>}
        </>
      ) : <p className="changes-empty">Aucun commit à afficher.</p>}
    </div>
  </section>
}

export function GitView({ project, conversation, focusedFlagId = null, reviewStatus = null, onConversationBack }: GitViewProps) {
  const [tab, setTab] = useState<Tab>('changes')
  const [snapshot, setSnapshot] = useState<GitSnapshot | null>(null)
  const [live, setLive] = useState<GitDiff | null>(null)
  const [reviews, setReviews] = useState<Review[]>([])
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!conversation) return
    const [loadedSnapshot, loadedLive, loadedReviews] = await Promise.all([
      getProjectGit(project.id, conversation.id, signal),
      getConversationDiff(conversation.id, signal),
      listProjectReviews(project.id, signal),
    ])
    if (signal?.aborted) return
    setSnapshot(loadedSnapshot)
    setLive(loadedLive)
    setReviews(loadedReviews)
  }, [project.id, conversation?.id])

  useEffect(() => {
    const controller = new AbortController()
    setError(null)
    void refresh(controller.signal).catch((reason) => { if (!controller.signal.aborted) setError(errorMessage(reason)) })
    return () => controller.abort()
  }, [refresh])

  const wasScanRunning = useRef(isScanRunning(reviewStatus))
  useEffect(() => {
    const running = isScanRunning(reviewStatus)
    if (wasScanRunning.current && !running) void refresh()
    wasScanRunning.current = running
  }, [reviewStatus, refresh])

  const review = conversation ? reviews.find((item) => item.conversation_id === conversation.id && item.scope === 'worktree') ?? null : null
  const hasRunningFlag = review?.flags.some((flag) => flag.status === 'agent_running') ?? false

  useEffect(() => {
    if (!hasRunningFlag) return
    const timer = window.setInterval(() => void refresh(), 2_000)
    return () => window.clearInterval(timer)
  }, [hasRunningFlag, refresh])

  function updateFlag(updated: ReviewFlag) {
    setReviews((current) => current.map((item) => item.id === updated.review_id
      ? { ...item, flags: item.flags.map((flag) => flag.id === updated.id ? updated : flag) }
      : item))
  }

  const diff = review?.diff_text ?? live?.diff ?? ''
  const flags = review?.flags ?? []
  const openFlags = flags.filter((flag) => flag.status === 'open' || flag.status === 'agent_running')
  const redCount = openFlags.filter((flag) => flag.severity === 'red').length
  const orangeCount = openFlags.filter((flag) => flag.severity === 'orange').length
  const fileCount = buildFileTree(diff, flags).length
  const commitCount = branchCommits(snapshot).length

  return <div className="code-workspace">
    <header className="code-header">
      <div className="code-header-title">
        <strong>{conversation?.title ?? project.name}</strong>
        <span>{snapshot?.currentBranch ?? 'HEAD détachée'}</span>
      </div>
      <SurfaceSwitch active="code" onConversation={onConversationBack} onCode={() => {}} />
    </header>
    {error ? <p className="code-error" role="alert">{error}</p> : null}
    {conversation === null ? (
      <p className="changes-empty">Sélectionnez une conversation pour voir ses changements.</p>
    ) : (
      <>
        <nav className="code-tabs" aria-label="Sections de la vue Code">
          <button type="button" className={tab === 'changes' ? 'is-active' : ''} onClick={() => setTab('changes')}>
            Changements <span>{fileCount} fichier{fileCount > 1 ? 's' : ''}{redCount > 0 || orangeCount > 0 ? ` · ${[redCount > 0 ? `${redCount} rouge${redCount > 1 ? 's' : ''}` : null, orangeCount > 0 ? `${orangeCount} orange${orangeCount > 1 ? 's' : ''}` : null].filter(Boolean).join(' / ')}` : ''}</span>
          </button>
          <button type="button" className={tab === 'history' ? 'is-active' : ''} onClick={() => setTab('history')}>
            Historique <span>{commitCount} commit{commitCount > 1 ? 's' : ''}</span>
          </button>
        </nav>
        {tab === 'changes'
          ? <ChangesTab
              project={project}
              conversation={conversation}
              live={live}
              review={review}
              reviewStatus={reviewStatus}
              focusedFlagId={focusedFlagId}
              onFlagUpdated={updateFlag}
              onRefresh={() => void refresh()}
            />
          : <HistoryTab
              project={project}
              conversation={conversation}
              snapshot={snapshot}
              reviews={reviews}
              onReviewStarted={(started) => setReviews((current) => [started, ...current.filter((item) => item.id !== started.id)])}
            />}
      </>
    )}
  </div>
}
