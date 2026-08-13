import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { dispatchAllFlags, getProjectGit, getProjectGitDiff, getReview, listPresets, listProjectReviews, listProjectWorktrees, removeProjectWorktree, startReview } from './api'
import { DiffViewer } from './DiffViewer'
import { defaultGitCompareRefs, gitGraphCellGeometry, gitGraphRowLabel, gitRefOptions, layoutGitGraph, updateGitCompareRef } from './gitGraph'
import { buildFileTree } from './reviewFileTree'
import { reviewStartInput } from './reviewLaunch'
import { isScanRunning } from './reviewStatus'
import { cleanupInvitation, disposableWorktrees, isRemovable, worktreeLabel, worktreeRows } from './worktrees'
import { ReviewConfigSelector, reviewPreset } from './ReviewConfigSelector'
import type { ReviewSelection } from './ReviewConfigSelector'
import type { Conversation, GitSnapshot, GitWorktree, Preset, Project, Provider, QuotaSnapshot, Review, ReviewFlag, ReviewStatusSnapshot } from './types'
import { BranchIcon } from './BranchIcon'
import { CorrectionConfigSelector } from './CorrectionConfigSelector'
import { readCorrectionSelection, writeCorrectionSelection } from './correctionConfig'
import type { CorrectionSelection } from './correctionConfig'
import { modelLabel } from './modelOptions'

interface GitViewProps {
  project: Project
  conversation: Conversation | null
  focusedReviewId?: string | null
  reviewStatus?: ReviewStatusSnapshot | null
  quotas: QuotaSnapshot
  onConversationSelect: (conversationId: string) => void
  onReviewSelected?: (reviewId: string) => void
  onConversationBack: () => void
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : 'La vue Git est indisponible.' }
function shortSha(sha: string): string { return sha.slice(0, 8) }
function shortDate(value: string): string {
  return new Date(value).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' })
}

export function GitView({ project, conversation, focusedReviewId = null, reviewStatus = null, quotas, onConversationSelect, onReviewSelected, onConversationBack }: GitViewProps) {
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
  const [isCleaning, setIsCleaning] = useState(false)
  const [presets, setPresets] = useState<Preset[]>([])
  const [presetId, setPresetId] = useState(project.default_preset_id ?? '')
  const [provider, setProvider] = useState<Provider>(conversation?.provider ?? 'codex')
  const [model, setModel] = useState(conversation?.provider === 'claude' ? 'opus' : 'gpt-5.6-sol')
  const [effort, setEffort] = useState('high')
  const [speed, setSpeed] = useState<'standard' | 'fast'>('standard')
  const [historyLimit, setHistoryLimit] = useState(25)
  const [historyScope, setHistoryScope] = useState<'branch' | 'all'>('branch')
  const [correction, setCorrection] = useState<CorrectionSelection>(() => conversation
    ? readCorrectionSelection(conversation)
    : { presetId: '', provider: 'codex', model: 'gpt-5.6-luna', effort: 'xhigh', speed: 'fast' })
  const wasScanning = useRef(false)

  useEffect(() => {
    const controller = new AbortController()
    void Promise.all([
      getProjectGit(project.id, conversation?.id, controller.signal),
      listProjectReviews(project.id, controller.signal),
    ])
      .then(([git, loadedReviews]) => {
        if (controller.signal.aborted) return
        const defaults = defaultGitCompareRefs(git)
        setSnapshot(git); setBaseRef(defaults.baseRef); setHeadRef(defaults.headRef)
        const conversationReviews = conversation
          ? loadedReviews.filter((review) => review.conversation_id === conversation.id)
          : loadedReviews
        setReviews(loadedReviews)
        setSelectedReviewId(focusedReviewId ?? conversationReviews[0]?.id ?? null)
        if (defaults.baseRef && defaults.headRef) {
          void getProjectGitDiff(
            project.id,
            defaults.baseRef,
            defaults.headRef,
            conversation?.id,
            controller.signal,
          ).then((loaded) => {
            if (!controller.signal.aborted) setDiff(loaded.diff)
          }).catch(() => {})
        }
      })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)) })
    return () => controller.abort()
  }, [conversation?.id, focusedReviewId, project.id])

  useEffect(() => {
    if (conversation) setCorrection(readCorrectionSelection(conversation))
  }, [conversation?.id])

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

  async function dropMerged() {
    const targets = disposableWorktrees(worktreeList)
    if (targets.length === 0 || isCleaning) return
    if (!window.confirm(`Retirer ${targets.length} worktree(s) de branches fusionnées ?\n\nLes branches, elles, sont conservées : seul le dossier de travail disparaît.`)) return
    setIsCleaning(true)
    setError(null)
    try {
      for (const row of targets) await removeProjectWorktree(project.id, row.worktree.path)
      refreshWorktrees()
      setSnapshot(await getProjectGit(project.id, conversation?.id))
    } catch (reason) { setError(errorMessage(reason)) }
    finally { setIsCleaning(false) }
  }

  async function dropWorktree(path: string) {
    setError(null)
    try {
      await removeProjectWorktree(project.id, path)
      refreshWorktrees()
      setSnapshot(await getProjectGit(project.id, conversation?.id))
    } catch (reason) { setError(errorMessage(reason)) }
  }

  useEffect(() => {
    const controller = new AbortController()
    void listPresets(controller.signal).then((loaded) => {
      if (controller.signal.aborted) return
      setPresets(loaded)
      const source = loaded.find((item) => item.id === project.default_preset_id)
      const preset = source ? reviewPreset(source) : null
      if (preset) { setProvider(preset.provider); setModel(preset.model); setEffort(preset.effort ?? 'high'); setSpeed(preset.provider === 'codex' ? (preset.speed ?? 'standard') : 'standard') }
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
  // Une ancienne review vide ne doit jamais masquer la comparaison courante :
  // c'est précisément le cas « 0 signalement » qui empêchait de consulter le
  // code alors que la branche contenait bien des changements.
  const displayedDiff = selectedReview?.diff_text || diff
  const flags = selectedReview?.flags ?? []
  const files = useMemo(() => displayedDiff ? buildFileTree(displayedDiff, flags) : [], [displayedDiff, flags])
  const filteredDiff = useMemo(() => {
    if (!displayedDiff || selectedFile === null) return displayedDiff
    return displayedDiff.split(/(?=^diff --git )/m).filter((chunk) => chunk.includes(` b/${selectedFile}\n`)).join('')
  }, [displayedDiff, selectedFile])
  const openFlags = flags.filter((flag) => flag.status === 'open' || flag.status === 'countered')
  const runningFlags = flags.filter((flag) => flag.status === 'agent_running')
  const shownFlags = flags.filter((flag) => filter === 'all' || filter === 'treated'
    ? filter === 'all' || flag.status === 'treated'
    : flag.severity === filter)
  const severityCounts = flags.reduce((counts, flag) => ({ ...counts, [flag.severity]: counts[flag.severity] + 1 }), { red: 0, orange: 0, grey: 0 })
  const historyCommits = useMemo(() => {
    if (!snapshot || historyScope === 'all' || !snapshot.branchCommitShas) return snapshot?.commits ?? []
    const bySha = new Map(snapshot.commits.map((commit) => [commit.sha, commit]))
    return snapshot.branchCommitShas.flatMap((sha) => bySha.get(sha) ?? [])
  }, [historyScope, snapshot])
  const rows = useMemo(() => layoutGitGraph(historyCommits), [historyCommits])
  const visibleRows = rows.slice(0, historyLimit)
  const worktreeList = useMemo(
    () => worktreeRows(worktrees.worktrees, worktrees.merged, conversation?.worktree_path ?? null),
    [worktrees, conversation?.worktree_path],
  )

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

  useEffect(() => {
    if (!selectedReview || runningFlags.length === 0) return
    let disposed = false
    const refresh = () => {
      void getReview(selectedReview.id).then((updated) => {
        if (!disposed) setReviews((current) => current.map((review) => review.id === updated.id ? updated : review))
      }).catch(() => {})
    }
    const timer = window.setInterval(refresh, 1_500)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [selectedReview?.id, runningFlags.length])

  async function compare() {
    if (!baseRef || !headRef) return
    setIsComparing(true); setError(null)
    try { setDiff((await getProjectGitDiff(project.id, baseRef, headRef, conversation?.id)).diff); setSelectedFile(null); setSelectedReviewId(null) }
    catch (reason) { setError(errorMessage(reason)) }
    finally { setIsComparing(false) }
  }

  async function relire() {
    if (!conversation || isReviewing) return
    setIsReviewing(true); setError(null)
    try {
      const review = await startReview({ ...reviewStartInput(conversation.id, diff === null ? null : { base: baseRef, head: headRef }), presetId: presetId || null, reviewProvider: provider, reviewModel: model, reviewEffort: effort, reviewSpeed: speed })
      setReviews((current) => [review, ...current.filter((item) => item.id !== review.id)])
      setSelectedReviewId(review.id); onReviewSelected?.(review.id)
    } catch (reason) { setError(errorMessage(reason)) }
    finally { setIsReviewing(false) }
  }

  async function dispatchOpen() {
    if (!selectedReview || isDispatching || openFlags.length === 0) return
    if (!window.confirm(`Lancer ${openFlags.length} agent${openFlags.length > 1 ? 's' : ''} avec ${modelLabel(correction.model)} ?\n\nUn agent distinct corrigera chaque signalement ouvert.`)) return
    setIsDispatching(true)
    const previous = selectedReview
    const dispatchedIds = new Set(openFlags.map((flag) => flag.id))
    setReviews((current) => current.map((review) => review.id !== selectedReview.id ? review : {
      ...review,
      flags: review.flags.map((flag) => dispatchedIds.has(flag.id) ? { ...flag, status: 'agent_running' } : flag),
    }))
    try {
      await dispatchAllFlags(selectedReview.id, ['red', 'orange', 'grey'], correction)
      const updated = await getReview(selectedReview.id)
      setReviews((current) => current.map((review) => review.id === updated.id ? updated : review))
    }
    catch (reason) {
      setReviews((current) => current.map((review) => review.id === previous.id ? previous : review))
      setError(errorMessage(reason))
    } finally { setIsDispatching(false) }
  }

  function updateFlag(updated: ReviewFlag) {
    setReviews((current) => current.map((review) => review.id !== updated.review_id ? review : { ...review, flags: review.flags.map((flag) => flag.id === updated.id ? updated : flag) }))
  }

  function updateRef(target: 'base' | 'head', value: string) {
    const next = updateGitCompareRef({ baseRef, headRef }, target, value)
    setBaseRef(next.baseRef); setHeadRef(next.headRef); setDiff(null); setSelectedFile(null)
  }

  function selectReviewConfig(next: ReviewSelection) {
    setPresetId(next.presetId)
    setProvider(next.provider)
    setModel(next.model)
    setEffort(next.effort)
    setSpeed(next.speed)
  }

  function selectCorrectionConfig(next: CorrectionSelection) {
    setCorrection(next)
    if (conversation) writeCorrectionSelection(conversation.id, next)
  }

  return <div className="git-workspace">
    <header className="git-header">
      <div className="git-context">
        <nav className="conversation-surface-tabs" aria-label="Vue de la conversation">
          <button type="button" onClick={onConversationBack}>Conversation</button>
          <button type="button" className="is-active" aria-current="page">Code</button>
        </nav>
        <span className="git-context-separator" aria-hidden="true" />
        <span className="git-current-branch" title={conversation?.worktree_path ?? project.path}>
          <BranchIcon />
          <strong>{snapshot?.currentBranch ?? 'HEAD détachée'}</strong>
          <span>{conversation?.worktree_path ? 'worktree de la conversation' : 'dépôt principal'}</span>
        </span>
      </div>
      <div className="git-review-actions">
        <span className={`git-review-mode ${conversation?.auto_review ? 'is-auto' : ''}`} title={conversation?.auto_review ? 'Cette conversation relance une review après chaque tour réussi.' : 'La review démarre uniquement quand vous la lancez.'}>
          {conversation?.auto_review ? 'Auto activée' : 'À la demande'}
        </span>
        <span className="git-config-purpose">Review</span>
        <ReviewConfigSelector value={{ presetId, provider, model, effort, speed }} presets={presets} quotas={quotas} busy={isReviewing} placement="bottom" submenuPlacement="left" onChange={selectReviewConfig} />
        <button type="button" className="primary-button" onClick={() => void relire()} disabled={!conversation || isReviewing || selectedReview?.status === 'running' || isScanRunning(reviewStatus)}>{isReviewing ? 'Lancement…' : reviewStatus?.running ? `Zone ${reviewStatus.running.zoneDone}/${reviewStatus.running.zoneTotal}` : selectedReview?.status === 'running' ? 'Analyse en cours…' : 'Lancer la review'}</button>
      </div>
    </header>
    {error ? <div className="git-error" role="alert">{error}</div> : null}
    <section className="git-compare" aria-label="Comparer deux références">
      <div className="git-compare-title"><strong>Changements</strong><span>{displayedDiff ? `${files.length} fichier${files.length === 1 ? '' : 's'}` : 'Aucun diff chargé'}</span></div>
      <label><span>Depuis</span><select value={baseRef} onChange={(event) => updateRef('base', event.target.value)}>{refs.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <span className="git-compare-arrow" aria-hidden="true">→</span>
      <label><span>Jusqu’à</span><select value={headRef} onChange={(event) => updateRef('head', event.target.value)}>{refs.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <button type="button" onClick={() => void compare()} disabled={!baseRef || !headRef || isComparing}>{isComparing ? 'Chargement…' : 'Actualiser'}</button>
    </section>
    {displayedDiff ? <section className="git-overlay-layout" aria-label="Diff annoté">
      <aside className="git-file-tree"><button type="button" className={selectedFile === null ? 'is-selected' : ''} onClick={() => { setSelectedFile(null); setSelectedFlagId(null) }}>Tous les fichiers <strong>{openFlags.length}</strong></button>{files.map((file) => <button type="button" className={selectedFile === file.path ? 'is-selected' : ''} key={file.path} onClick={() => { setSelectedFile(file.path); setSelectedFlagId(shownFlags.find((flag) => flag.file === file.path)?.id ?? null) }}><span>{file.path}</span><small>+{file.additions} −{file.deletions}</small><em className="risk-red">{file.counts.red}</em><em className="risk-orange">{file.counts.orange}</em><em className="risk-grey">{file.counts.grey}</em></button>)}</aside>
      <div className="git-overlay-diff"><header className="git-review-toolbar"><div className="git-review-filters"><button type="button" className={filter === 'red' ? 'is-active' : ''} onClick={() => setFilter(filter === 'red' ? 'all' : 'red')}>Rouge {severityCounts.red}</button><button type="button" className={filter === 'orange' ? 'is-active' : ''} onClick={() => setFilter(filter === 'orange' ? 'all' : 'orange')}>Orange {severityCounts.orange}</button><button type="button" className={filter === 'treated' ? 'is-active' : ''} onClick={() => setFilter(filter === 'treated' ? 'all' : 'treated')}>Traitées {flags.filter((flag) => flag.status === 'treated').length}</button></div>{selectedReview ? <div className="git-correction-actions"><span className="git-correction-purpose">Correction</span><CorrectionConfigSelector value={correction} presets={presets} quotas={quotas} busy={isDispatching || runningFlags.length > 0} placement="bottom" submenuPlacement="left" onChange={selectCorrectionConfig} /><button type="button" onClick={() => void dispatchOpen()} disabled={isDispatching || runningFlags.length > 0 || openFlags.length === 0}>{isDispatching ? 'Lancement…' : runningFlags.length > 0 ? `${runningFlags.length} agent${runningFlags.length > 1 ? 's' : ''} en cours` : `Corriger les ${openFlags.length} ouverts`}</button></div> : null}</header><DiffViewer diff={filteredDiff ?? ''} flags={shownFlags} selectedFlagId={selectedFlagId} label="Diff Git annoté" onFlagUpdated={updateFlag} correction={correction} /></div>
    </section> : <div className="git-diff-empty"><strong>Aucun changement entre ces deux points.</strong><span>Le diff reste consultable indépendamment des signalements du Gardien.</span></div>}
    <section className="git-worktrees" aria-label="Worktrees du projet">
      <h2>Worktrees</h2>
      {cleanupInvitation(worktreeList) !== null ? <p className="git-worktree-invite" role="status">
        <span>{cleanupInvitation(worktreeList)}</span>
        <button type="button" onClick={() => void dropMerged()} disabled={isCleaning}>
          {isCleaning ? 'Nettoyage…' : 'Retirer'}
        </button>
      </p> : null}
      <ul className="git-worktree-list">{worktreeList.map((row) => <li key={row.worktree.path} className={row.current ? 'is-current' : undefined}>
        <strong>{worktreeLabel(row.worktree)}</strong>
        <code>{row.worktree.path}</code>
        {row.main ? <em>dépôt principal</em> : null}
        {row.current ? <em>conversation ouverte</em> : null}
        {row.merged && !row.main ? <em className="is-merged">fusionnée</em> : null}
        {isRemovable(row) ? <button type="button" onClick={() => void dropWorktree(row.worktree.path)}>Retirer</button> : null}
      </li>)}</ul>
    </section>
    <section className="git-history">
      <header className="git-history-header">
        <div><h2>Commits</h2><span>{historyScope === 'branch' ? `${rows.length} sur ${snapshot?.currentBranch ?? 'la branche'} depuis ${snapshot?.branchBase ?? 'sa base'}` : `${rows.length} dans tout le dépôt`}</span></div>
        <div className="git-history-scope" role="group" aria-label="Portée de l’historique">
          <button type="button" className={historyScope === 'branch' ? 'is-active' : ''} onClick={() => { setHistoryScope('branch'); setHistoryLimit(25) }}>Cette branche</button>
          <button type="button" className={historyScope === 'all' ? 'is-active' : ''} onClick={() => { setHistoryScope('all'); setHistoryLimit(25) }}>Tout l’historique</button>
        </div>
      </header>
      <div className="git-history-list">
        {visibleRows.length === 0 ? <p className="git-history-empty">Aucun commit propre à <strong>{snapshot?.currentBranch ?? 'cette branche'}</strong> depuis {snapshot?.branchBase ?? 'sa base'}.</p> : null}
        {visibleRows.map((row) => {
          const geometry = gitGraphCellGeometry(row)
          const latestReview = row.commit.guardian.at(-1)
          const reviewCount = row.commit.guardian.length
          const linkedConversation = row.commit.conversations[0]
          const issueCount = latestReview ? latestReview.red + latestReview.orange + latestReview.grey : 0
          return <article className={row.commit.sha === snapshot?.head ? 'git-commit is-head' : 'git-commit'} key={row.commit.sha}>
            <span className="git-lanes" style={{ width: geometry.width }} role="img" aria-label={gitGraphRowLabel(row)}><svg viewBox={`0 0 ${geometry.width} ${geometry.viewBoxHeight}`} preserveAspectRatio="none">{geometry.paths.map((path, index) => <path key={index} className={path.kind === 'parent' ? 'is-parent' : undefined} d={path.d} />)}</svg><i className="git-lane-dot" style={{ left: geometry.dot.x }} /></span>
            <div className="git-commit-copy">
              <div className="git-commit-title"><strong>{row.commit.subject}</strong><code>{shortSha(row.commit.sha)}</code></div>
              <div className="git-commit-meta"><span>{row.commit.author}</span><span>{shortDate(row.commit.authoredAt)}</span>{row.commit.refs.slice(0, 2).map((ref) => <span className="git-commit-ref" key={ref}>{ref}</span>)}</div>
              {linkedConversation || latestReview ? <div className="git-commit-links">
                {linkedConversation ? <button type="button" onClick={() => onConversationSelect(linkedConversation.id)}>Conversation · {linkedConversation.title}{row.commit.conversations.length > 1 ? ` +${row.commit.conversations.length - 1}` : ''}</button> : null}
                {latestReview ? <button type="button" className={issueCount > 0 ? 'has-issues' : 'is-clean'} onClick={() => { setSelectedReviewId(latestReview.reviewId); onReviewSelected?.(latestReview.reviewId) }}>{issueCount === 0 ? 'Review conforme' : `${issueCount} signalement${issueCount > 1 ? 's' : ''}`}{reviewCount > 1 ? ` · ${reviewCount} passages` : ''}</button> : null}
              </div> : null}
            </div>
          </article>
        })}
      </div>
      {historyLimit < rows.length ? <button type="button" className="git-history-more" onClick={() => setHistoryLimit((current) => current + 25)}>Afficher 25 commits précédents</button> : null}
    </section>
  </div>
}
