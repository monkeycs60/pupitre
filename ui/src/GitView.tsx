import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { dispatchAllFlags, getProjectGit, getProjectGitDiff, getReview, listPresets, listProjectReviews, listProjectWorktrees, removeProjectWorktree, startReview, updatePreset } from './api'
import { DiffViewer } from './DiffViewer'
import { gitGraphCellGeometry, gitGraphRowLabel, gitRefOptions, layoutGitGraph, updateGitCompareRef } from './gitGraph'
import { buildFileTree } from './reviewFileTree'
import { reviewStartInput } from './reviewLaunch'
import { isScanRunning } from './reviewStatus'
import { isRemovable, worktreeLabel, worktreeRows } from './worktrees'
import { PROVIDER_EFFORTS, REVIEW_MODELS } from './modelOptions'
import type { Conversation, GitSnapshot, GitWorktree, Preset, Project, Provider, Review, ReviewFlag, ReviewStatusSnapshot } from './types'

interface GitViewProps {
  project: Project
  conversation: Conversation | null
  focusedReviewId?: string | null
  reviewStatus?: ReviewStatusSnapshot | null
  onConversationSelect: (conversationId: string) => void
  onReviewSelected?: (reviewId: string) => void
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : 'La vue Git est indisponible.' }
function shortSha(sha: string): string { return sha.slice(0, 8) }

export function GitView({ project, conversation, focusedReviewId = null, reviewStatus = null, onConversationSelect, onReviewSelected }: GitViewProps) {
  const [snapshot, setSnapshot] = useState<GitSnapshot | null>(null)
  const [baseRef, setBaseRef] = useState('')
  const [headRef, setHeadRef] = useState('')
  const [diff, setDiff] = useState<string | null>(null)
  const [reviews, setReviews] = useState<Review[]>([])
  const [selectedReviewId, setSelectedReviewId] = useState<string | null>(focusedReviewId)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isComparing, setIsComparing] = useState(false)
  const [isReviewing, setIsReviewing] = useState(false)
  const [isDispatching, setIsDispatching] = useState(false)
  const [filter, setFilter] = useState<'all' | 'red' | 'orange' | 'treated'>('all')
  const [selectedFlagId, setSelectedFlagId] = useState<string | null>(null)
  const [worktrees, setWorktrees] = useState<{ worktrees: GitWorktree[], merged: GitWorktree[] }>({ worktrees: [], merged: [] })
  const [presets, setPresets] = useState<Preset[]>([])
  const [presetId, setPresetId] = useState(project.default_preset_id ?? '')
  const [provider, setProvider] = useState<Provider>(conversation?.provider ?? 'codex')
  const [model, setModel] = useState(conversation?.provider === 'claude' ? 'opus' : 'gpt-5.6-sol')
  const [effort, setEffort] = useState('high')
  const [remember, setRemember] = useState(false)
  const wasScanning = useRef(false)

  useEffect(() => {
    const controller = new AbortController()
    void Promise.all([getProjectGit(project.id, controller.signal), listProjectReviews(project.id, controller.signal)])
      .then(([git, loadedReviews]) => {
        if (controller.signal.aborted) return
        setSnapshot(git); setBaseRef(git.headParents[0] ?? ''); setHeadRef(git.head ?? '')
        setReviews(loadedReviews); setSelectedReviewId(focusedReviewId ?? loadedReviews[0]?.id ?? null)
      })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)) })
    return () => controller.abort()
  }, [focusedReviewId, project.id])

  const refreshWorktrees = useCallback((signal?: AbortSignal) => {
    void listProjectWorktrees(project.id, signal)
      .then((loaded) => { if (!signal?.aborted) setWorktrees(loaded) })
      .catch(() => {})
  }, [project.id])

  useEffect(() => {
    const controller = new AbortController()
    refreshWorktrees(controller.signal)
    return () => controller.abort()
  }, [refreshWorktrees])

  async function dropWorktree(path: string) {
    setError(null)
    try {
      await removeProjectWorktree(project.id, path)
      refreshWorktrees()
      setSnapshot(await getProjectGit(project.id))
    } catch (reason) { setError(errorMessage(reason)) }
  }

  useEffect(() => {
    const controller = new AbortController()
    void listPresets(controller.signal).then((loaded) => {
      if (controller.signal.aborted) return
      setPresets(loaded)
      const preset = loaded.find((item) => item.id === project.default_preset_id)
      if (preset) { setProvider(preset.review_provider); setModel(preset.review_model); setEffort(preset.review_effort) }
    }).catch(() => {})
    return () => controller.abort()
  }, [project.default_preset_id])

  useEffect(() => {
    const scanning = isScanRunning(reviewStatus)
    if (wasScanning.current && !scanning) {
      void listProjectReviews(project.id).then((loaded) => {
        setReviews(loaded)
        setSelectedReviewId((current) => reviewStatus?.running?.reviewId ?? current ?? loaded[0]?.id ?? null)
      }).catch(() => {})
    }
    wasScanning.current = scanning
  }, [project.id, reviewStatus?.running])

  const refs = useMemo(() => snapshot ? gitRefOptions(snapshot) : [], [snapshot])
  const selectedReview = reviews.find((review) => review.id === selectedReviewId) ?? null
  const displayedDiff = selectedReview?.diff_text ?? diff
  const flags = selectedReview?.flags ?? []
  const files = useMemo(() => displayedDiff ? buildFileTree(displayedDiff, flags) : [], [displayedDiff, flags])
  const filteredDiff = useMemo(() => {
    if (!displayedDiff || selectedFile === null) return displayedDiff
    return displayedDiff.split(/(?=^diff --git )/m).filter((chunk) => chunk.includes(` b/${selectedFile}\n`)).join('')
  }, [displayedDiff, selectedFile])
  const openFlags = flags.filter((flag) => flag.status === 'open' || flag.status === 'countered')
  const shownFlags = flags.filter((flag) => filter === 'all' || filter === 'treated'
    ? filter === 'all' || flag.status === 'treated'
    : flag.severity === filter)
  const severityCounts = flags.reduce((counts, flag) => ({ ...counts, [flag.severity]: counts[flag.severity] + 1 }), { red: 0, orange: 0, grey: 0 })
  const rows = useMemo(() => layoutGitGraph(snapshot?.commits ?? []), [snapshot])

  // Filet de sécurité lorsque le WS a été reconnecté entre la dernière zone et
  // la fin du scan : un unique intervalle existe seulement pour la review active.
  useEffect(() => {
    if (selectedReview?.status !== 'running') return
    let disposed = false
    const refresh = () => {
      void getReview(selectedReview.id)
        .then((updated) => {
          if (disposed) return
          setReviews((current) => current.map((review) => review.id === updated.id ? updated : review))
        })
        .catch(() => {})
    }
    refresh()
    const timer = setInterval(refresh, 1_500)
    return () => { disposed = true; clearInterval(timer) }
  }, [selectedReview?.id, selectedReview?.status])

  async function compare() {
    if (!baseRef || !headRef) return
    setIsComparing(true); setError(null)
    try { setDiff((await getProjectGitDiff(project.id, baseRef, headRef)).diff); setSelectedFile(null) }
    catch (reason) { setError(errorMessage(reason)) }
    finally { setIsComparing(false) }
  }

  async function relire() {
    if (!conversation || isReviewing) return
    setIsReviewing(true); setError(null)
    try {
      const selectedPreset = presets.find((item) => item.id === presetId)
      if (remember && selectedPreset && !selectedPreset.built_in) await updatePreset(selectedPreset.id, { ...selectedPreset, review_provider: provider, review_model: model, review_effort: effort })
      const review = await startReview({ ...reviewStartInput(conversation.id, diff === null ? null : { base: baseRef, head: headRef }), presetId: presetId || null, reviewProvider: provider, reviewModel: model, reviewEffort: effort })
      setReviews((current) => [review, ...current.filter((item) => item.id !== review.id)])
      setSelectedReviewId(review.id); onReviewSelected?.(review.id)
    } catch (reason) { setError(errorMessage(reason)) }
    finally { setIsReviewing(false) }
  }

  async function dispatchOpen() {
    if (!selectedReview || isDispatching || openFlags.length === 0) return
    if (!window.confirm(`Traiter les ${openFlags.length} signalements ouverts ?`)) return
    setIsDispatching(true)
    try { await dispatchAllFlags(selectedReview.id); setReviews(await listProjectReviews(project.id)) }
    catch (reason) { setError(errorMessage(reason)) }
    finally { setIsDispatching(false) }
  }

  function updateFlag(updated: ReviewFlag) {
    setReviews((current) => current.map((review) => review.id !== updated.review_id ? review : { ...review, flags: review.flags.map((flag) => flag.id === updated.id ? updated : flag) }))
  }

  function updateRef(target: 'base' | 'head', value: string) {
    const next = updateGitCompareRef({ baseRef, headRef }, target, value)
    setBaseRef(next.baseRef); setHeadRef(next.headRef); setDiff(null); setSelectedFile(null)
  }

  function selectPreset(nextId: string) {
    setPresetId(nextId); setRemember(false)
    const preset = presets.find((item) => item.id === nextId)
    if (preset) { setProvider(preset.review_provider); setModel(preset.review_model); setEffort(preset.review_effort) }
  }

  return <div className="git-workspace">
    <header className="git-header"><div><h1>Git · {project.name}</h1><p>{snapshot?.currentBranch ?? 'HEAD détachée'}</p></div>
      <div className="git-review-actions"><button type="button" className="primary-button" onClick={() => void relire()} disabled={!conversation || isReviewing || isScanRunning(reviewStatus)}>{isReviewing ? 'Lancement…' : reviewStatus?.running ? `Zone ${reviewStatus.running.zoneDone}/${reviewStatus.running.zoneTotal}` : 'Relire ce diff'}</button><details className="git-review-settings"><summary>⚙</summary><div><label>Preset <select value={presetId} onChange={(event) => selectPreset(event.target.value)}><option value="">Configuration manuelle</option>{presets.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Provider <select value={provider} onChange={(event) => { const next = event.target.value as Provider; setProvider(next); setModel(REVIEW_MODELS[next][0]) }}><option value="codex">codex</option><option value="claude">claude</option></select></label><label>Modèle <select value={model} onChange={(event) => setModel(event.target.value)}>{REVIEW_MODELS[provider].map((item) => <option key={item} value={item}>{item}</option>)}</select></label><label>Effort <select value={effort} onChange={(event) => setEffort(event.target.value)}>{PROVIDER_EFFORTS[provider].map((item) => <option key={item} value={item}>{item}</option>)}</select></label>{presets.find((item) => item.id === presetId) && !presets.find((item) => item.id === presetId)?.built_in ? <label><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} /> Mémoriser dans le preset</label> : null}</div></details></div>
    </header>
    {error ? <div className="git-error" role="alert">{error}</div> : null}
    <section className="git-compare" aria-label="Comparer deux références"><label>Base <select value={baseRef} onChange={(event) => updateRef('base', event.target.value)}>{refs.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>Cible <select value={headRef} onChange={(event) => updateRef('head', event.target.value)}>{refs.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><button type="button" onClick={() => void compare()} disabled={!baseRef || !headRef || isComparing}>{isComparing ? 'Comparaison…' : 'Afficher le diff'}</button></section>
    {displayedDiff ? <section className="git-overlay-layout" aria-label="Diff annoté">
      <aside className="git-file-tree"><button type="button" className={selectedFile === null ? 'is-selected' : ''} onClick={() => { setSelectedFile(null); setSelectedFlagId(null) }}>Tous les fichiers <strong>{openFlags.length}</strong></button>{files.map((file) => <button type="button" className={selectedFile === file.path ? 'is-selected' : ''} key={file.path} onClick={() => { setSelectedFile(file.path); setSelectedFlagId(shownFlags.find((flag) => flag.file === file.path)?.id ?? null) }}><span>{file.path}</span><small>+{file.additions} −{file.deletions}</small><em className="risk-red">{file.counts.red}</em><em className="risk-orange">{file.counts.orange}</em><em className="risk-grey">{file.counts.grey}</em></button>)}</aside>
      <div className="git-overlay-diff"><header className="git-review-toolbar"><button type="button" className={filter === 'red' ? 'is-active' : ''} onClick={() => setFilter(filter === 'red' ? 'all' : 'red')}>Rouge {severityCounts.red}</button><button type="button" className={filter === 'orange' ? 'is-active' : ''} onClick={() => setFilter(filter === 'orange' ? 'all' : 'orange')}>Orange {severityCounts.orange}</button><button type="button" className={filter === 'treated' ? 'is-active' : ''} onClick={() => setFilter(filter === 'treated' ? 'all' : 'treated')}>Traitées {flags.filter((flag) => flag.status === 'treated').length}</button>{selectedReview ? <button type="button" onClick={() => void dispatchOpen()} disabled={isDispatching || openFlags.length === 0}>{isDispatching ? 'Envoi…' : `Traiter les ${openFlags.length} ouverts`}</button> : null}</header><DiffViewer diff={filteredDiff ?? ''} flags={shownFlags} selectedFlagId={selectedFlagId} label="Diff Git annoté" onFlagUpdated={updateFlag} /></div>
    </section> : <p className="git-diff-empty">Choisissez deux points ou lancez une relecture du worktree.</p>}
    <section className="git-worktrees" aria-label="Worktrees du projet">
      <h2>Worktrees</h2>
      <ul className="git-worktree-list">{worktreeRows(worktrees.worktrees, worktrees.merged, conversation?.worktree_path ?? null).map((row) => <li key={row.worktree.path} className={row.current ? 'is-current' : undefined}>
        <strong>{worktreeLabel(row.worktree)}</strong>
        <code>{row.worktree.path}</code>
        {row.main ? <em>dépôt principal</em> : null}
        {row.current ? <em>conversation ouverte</em> : null}
        {row.merged && !row.main ? <em className="is-merged">fusionnée</em> : null}
        {isRemovable(row) ? <button type="button" onClick={() => void dropWorktree(row.worktree.path)}>Retirer</button> : null}
      </li>)}</ul>
    </section>
    <section className="git-history"><h2>Commits</h2>{rows.map((row, rowIndex) => { const geometry = gitGraphCellGeometry(row); return <article className={rowIndex === 0 ? 'git-commit is-head' : 'git-commit'} key={row.commit.sha}><span className="git-lanes" style={{ width: geometry.width }} role="img" aria-label={gitGraphRowLabel(row)}><svg viewBox={`0 0 ${geometry.width} ${geometry.viewBoxHeight}`} preserveAspectRatio="none">{geometry.paths.map((path, index) => <path key={index} className={path.kind === 'parent' ? 'is-parent' : undefined} d={path.d} />)}</svg><i className="git-lane-dot" style={{ left: geometry.dot.x }} /></span><div className="git-commit-copy"><strong>{row.commit.subject}</strong><code>{shortSha(row.commit.sha)}</code><div className="git-commit-links">{row.commit.conversations.map((item) => <button type="button" key={item.id} onClick={() => onConversationSelect(item.id)}>Conversation · {item.title}</button>)}{row.commit.guardian.map((review) => <button type="button" key={review.reviewId} onClick={() => { setSelectedReviewId(review.reviewId); onReviewSelected?.(review.reviewId) }}>Review · {review.red} rouge, {review.orange} orange</button>)}</div></div></article> })}</section>
  </div>
}
