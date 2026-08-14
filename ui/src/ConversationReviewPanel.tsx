import { useEffect, useMemo, useRef, useState } from 'react'
import { dispatchAllFlags, dispatchFlag, getProjectGit, getReview, listPresets, listProjectReviews, setConversationReviewConfig, setReviewFlagStatus, startReview } from './api'
import { REVIEW_MODELS, modelLabel } from './modelOptions'
import { buildFileTree } from './reviewFileTree'
import { reviewCoversHead } from './reviewFreshness'
import { reviewPreset } from './ReviewConfigSelector'
import type { ReviewSelection } from './ReviewConfigSelector'
import type { Conversation, Preset, Project, Provider, QuotaSnapshot, Review, ReviewFlag, ReviewStatusSnapshot } from './types'
import { readCorrectionSelection, writeCorrectionSelection } from './correctionConfig'
import type { CorrectionSelection } from './correctionConfig'
import { GuardianSettingsPopover } from './GuardianSettingsPopover'

interface Props {
  conversation: Conversation
  project: Project
  reviewStatus: ReviewStatusSnapshot | null
  onConversationUpdated: (conversation: Conversation) => void
  onOpenCode: (flagId?: string) => void
  quotas: QuotaSnapshot
  launchRequest?: number
}

type GuardianVariant = 'idle' | 'running' | 'clean' | 'warn' | 'block'

const CLOSED_FLAG_STATUSES = new Set<ReviewFlag['status']>(['treated', 'ignored', 'resolved'])

function initialProvider(conversation: Conversation): Provider {
  return conversation.review_provider ?? conversation.provider
}

function targetLabel(path: string | null): string {
  if (!path) return 'projet'
  return path.split(/[\\/]/).at(-1) || path
}

function GuardianShield() {
  return <svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden="true"><path d="M8 2 13 4v4c0 3-2 5-5 6-3-1-5-3-5-6V4l5-2Z" /></svg>
}

function GuardianGear() {
  return <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="2.1" /><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1" /></svg>
}

function GuardianChevron({ expanded }: { expanded: boolean }) {
  return <svg className={expanded ? 'is-expanded' : undefined} viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 6.5 8 10.5l4-4" /></svg>
}

function FindingPreview({
  flag,
  onOpenCode,
  onCorrect,
  onAcknowledge,
}: {
  flag: ReviewFlag
  onOpenCode: (flagId?: string) => void
  onCorrect: () => void
  onAcknowledge: () => void
}) {
  return (
    <div className={`guardian-finding risk-${flag.severity}`}>
      <span className="guardian-finding-dot" aria-hidden="true" />
      <div className="guardian-finding-copy">
        <div className="guardian-finding-head">
          <span className="guardian-finding-path">{flag.file}<b>:{flag.line_start}</b></span>
          <span className="guardian-finding-theme" title={flag.category || 'signalement'}>{flag.category || 'signalement'}</span>
        </div>
        <p>{flag.message}</p>
        <div className="guardian-finding-actions">
          <button type="button" className="is-link" onClick={() => onOpenCode(flag.id)}>Voir dans le diff</button>
          <button type="button" onClick={onCorrect} disabled={flag.status === 'agent_running'}>{flag.status === 'agent_running' ? 'Correction…' : 'Corriger'}</button>
          <button type="button" onClick={onAcknowledge}>OK, vu</button>
        </div>
      </div>
    </div>
  )
}

export function ConversationReviewPanel({
  conversation,
  project,
  reviewStatus,
  onConversationUpdated,
  onOpenCode,
  quotas,
  launchRequest = 0,
}: Props) {
  const initial = initialProvider(conversation)
  const [selection, setSelection] = useState<ReviewSelection>({
    presetId: '',
    provider: initial,
    model: conversation.review_model ?? REVIEW_MODELS[initial][0],
    effort: conversation.review_effort ?? 'high',
    speed: conversation.review_speed ?? 'standard',
  })
  const [presets, setPresets] = useState<Preset[]>([])
  const [review, setReview] = useState<Review | null>(null)
  const [currentHead, setCurrentHead] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [correction, setCorrection] = useState<CorrectionSelection>(() => readCorrectionSelection(conversation))
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const handledLaunchRequest = useRef(launchRequest)

  useEffect(() => {
    const controller = new AbortController()
    void listPresets(controller.signal).then(setPresets).catch(() => {})
    return () => controller.abort()
  }, [])

  useEffect(() => setCorrection(readCorrectionSelection(conversation)), [conversation.id])

  useEffect(() => {
    const controller = new AbortController()
    const refresh = () => {
      void Promise.all([
        listProjectReviews(project.id, controller.signal),
        getProjectGit(project.id, conversation.id, controller.signal),
      ])
        .then(([items, git]) => {
          setReview(items.find((item) => item.conversation_id === conversation.id) ?? null)
          setCurrentHead(git.head)
        })
        .catch((cause) => {
          if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Review indisponible')
        })
    }
    refresh()
    const timer = reviewStatus?.running || review?.status === 'running' || review?.flags.some((flag) => flag.status === 'agent_running')
      ? window.setInterval(refresh, 1_500)
      : null
    return () => {
      controller.abort()
      if (timer !== null) window.clearInterval(timer)
    }
  }, [conversation.id, project.id, review?.status, review?.flags, reviewStatus?.running?.reviewId])

  useEffect(() => {
    if (review?.status !== 'running') return
    let disposed = false
    const refresh = () => {
      void getReview(review.id).then((updated) => {
        if (!disposed) setReview(updated)
      }).catch(() => {})
    }
    const timer = window.setInterval(refresh, 1_500)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [review?.id, review?.status])

  const files = useMemo(() => review ? buildFileTree(review.diff_text, review.flags) : [], [review])
  const openFlags = review?.flags.filter((flag) => !CLOSED_FLAG_STATUSES.has(flag.status)) ?? []
  const runningHere = reviewStatus?.running?.reviewId === review?.id || review?.status === 'running'
  const showingProgress = busy || runningHere
  const coversCurrentHead = reviewCoversHead(review, currentHead)
  const hasCurrentResult = review?.status === 'done' && coversCurrentHead
  const isStale = review?.status === 'done' && !coversCurrentHead
  const variant: GuardianVariant = showingProgress
    ? 'running'
    : hasCurrentResult && openFlags.length === 0
      ? 'clean'
      : hasCurrentResult && openFlags.some((flag) => flag.severity === 'red')
        ? 'block'
        : hasCurrentResult && openFlags.length > 0
          ? 'warn'
          : 'idle'
  const visibleFlags = openFlags.slice(0, 4)
  const inferredPreset = presets.find((preset) => {
    const config = reviewPreset(preset)
    return config.provider === selection.provider
      && config.model === selection.model
      && config.effort === selection.effort
      && (selection.provider !== 'codex' || (config.speed ?? 'standard') === selection.speed)
  })
  const selectorValue = { ...selection, presetId: selection.presetId || inferredPreset?.id || '' }
  const target = targetLabel(conversation.worktree_path ?? project.path)

  useEffect(() => {
    if (variant === 'block') setExpanded(true)
  }, [variant])

  useEffect(() => {
    if (!expanded) return
    window.requestAnimationFrame(() => document.getElementById('guardian-findings')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }))
  }, [expanded])

  async function save(next: ReviewSelection = selection, enabled = Boolean(conversation.auto_review)) {
    setError(null)
    try {
      const updated = await setConversationReviewConfig(conversation.id, {
        enabled,
        reviewProvider: next.provider,
        reviewModel: next.model,
        reviewEffort: next.effort,
        reviewSpeed: next.speed,
      })
      onConversationUpdated(updated)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Réglage impossible')
    }
  }

  async function launch() {
    if (busy || runningHere || Boolean(reviewStatus?.running)) return
    setBusy(true)
    setError(null)
    setToast(null)
    try {
      const started = await startReview({
        conversationId: conversation.id,
        scope: 'worktree',
        gitRefBase: 'CONVERSATION',
        gitRefHead: 'WORKTREE',
        reviewProvider: selection.provider,
        reviewModel: selection.model,
        reviewEffort: selection.effort,
        reviewSpeed: selection.speed,
        codeProvider: conversation.provider,
      })
      setReview(started)
    } catch (cause) {
      setToast(cause instanceof Error ? cause.message : 'Review impossible')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (launchRequest === handledLaunchRequest.current) return
    handledLaunchRequest.current = launchRequest
    void launch()
  }, [launchRequest])

  function selectCorrection(next: CorrectionSelection) {
    setCorrection(next)
    writeCorrectionSelection(conversation.id, next)
  }

  function replaceFlag(updated: ReviewFlag) {
    setReview((current) => current ? { ...current, flags: current.flags.map((flag) => flag.id === updated.id ? updated : flag) } : current)
  }

  async function acknowledge(flag: ReviewFlag) {
    const optimistic = { ...flag, status: 'treated' as const }
    replaceFlag(optimistic)
    try {
      replaceFlag(await setReviewFlagStatus(flag.id, 'treated'))
    } catch (cause) {
      replaceFlag(flag)
      setToast(cause instanceof Error ? cause.message : 'Mise à jour impossible')
    }
  }

  async function correct(flag: ReviewFlag) {
    replaceFlag({ ...flag, status: 'agent_running' })
    try {
      const result = await dispatchFlag(flag.id, undefined, correction)
      replaceFlag({ ...flag, status: 'agent_running', subtask_id: result.subtaskId })
    } catch (cause) {
      replaceFlag(flag)
      setToast(cause instanceof Error ? cause.message : 'Correction impossible')
    }
  }

  async function correctAll() {
    if (!review || openFlags.length === 0 || busy) return
    if (!window.confirm(`Lancer ${openFlags.length} correction${openFlags.length > 1 ? 's' : ''} ?`)) return
    const previous = review
    setBusy(true)
    setReview({ ...review, flags: review.flags.map((flag) => openFlags.some((openFlag) => openFlag.id === flag.id) ? { ...flag, status: 'agent_running' } : flag) })
    try {
      await dispatchAllFlags(review.id, ['red', 'orange', 'grey'], correction)
      setReview(await getReview(review.id))
    } catch (cause) {
      setReview(previous)
      setToast(cause instanceof Error ? cause.message : 'Corrections impossibles')
    } finally {
      setBusy(false)
    }
  }

  const actionLabel = variant === 'block' ? 'Tout corriger' : variant === 'running' ? 'Annuler' : variant === 'clean' || variant === 'warn' ? 'Relire' : 'Lancer'
  const title = variant === 'running' ? 'le Gardien relit' : variant === 'clean' ? 'Gardien conforme' : 'Gardien'
  const meta = variant === 'running'
    ? reviewStatus?.running ? `analyse du diff · zone ${reviewStatus.running.zoneDone}/${reviewStatus.running.zoneTotal}` : 'préparation du diff'
    : review?.status === 'error'
      ? 'review interrompue'
      : isStale
        ? `HEAD ${review.git_ref_head.slice(0, 7)} non relu`
        : hasCurrentResult
      ? `${files.length} fichier${files.length > 1 ? 's' : ''} · ${modelLabel(review?.review_model ?? selection.model)}`
      : `à la demande · ${modelLabel(selection.model)}`

  return (
    <section className="conversation-review" id="conversation-review-panel" aria-label="Review Gardien">
      {toast ? <div className="conversation-review-toast" role="alert"><span>{toast}</span><button type="button" onClick={() => setToast(null)} aria-label="Fermer la notification">×</button></div> : null}
      <div className={`guardian-line is-${variant}`} role="group" aria-label={`Gardien${openFlags.length > 0 ? ` — ${openFlags.length} signalement${openFlags.length > 1 ? 's' : ''}` : ''}`}>
        <span className="guardian-line-status" aria-hidden="true">
          {variant === 'running' ? <span className="guardian-line-dots"><i /><i /><i /></span> : <GuardianShield />}
        </span>
        <strong className="guardian-line-title">{title}</strong>
        {openFlags.length > 0 && variant !== 'running' ? (
          <span className="guardian-line-chip"><i />{openFlags.filter((flag) => flag.severity === 'red').length > 0 ? `${openFlags.filter((flag) => flag.severity === 'red').length} rouge` : ''}{openFlags.filter((flag) => flag.severity === 'red').length > 0 && openFlags.filter((flag) => flag.severity === 'orange').length > 0 ? ' · ' : ''}{openFlags.filter((flag) => flag.severity === 'orange').length > 0 ? `${openFlags.filter((flag) => flag.severity === 'orange').length} orange` : ''}{openFlags.every((flag) => flag.severity === 'grey') ? `${openFlags.length} gris` : ''}</span>
        ) : null}
        <span className="guardian-line-meta">{meta}</span>
        <button type="button" className={`guardian-line-action${variant === 'block' ? ' is-primary' : ''}`} onClick={() => variant === 'block' ? void correctAll() : void launch()} disabled={variant === 'running' || busy || Boolean(reviewStatus?.running && !runningHere)}>{busy && variant !== 'block' ? 'Lancement…' : actionLabel}</button>
        <div className="guardian-line-tools">
          <button type="button" className="guardian-line-icon" aria-label="Réglages du Gardien" aria-expanded={settingsOpen} aria-controls="guardian-settings-popover" onClick={() => setSettingsOpen((current) => !current)}><GuardianGear /></button>
          {openFlags.length > 0 ? <button type="button" className="guardian-line-icon guardian-line-chevron" aria-label={expanded ? 'Replier les signalements' : 'Déplier les signalements'} aria-expanded={expanded} aria-controls="guardian-findings" onClick={() => setExpanded((current) => !current)}><GuardianChevron expanded={expanded} /></button> : null}
          {settingsOpen ? (
            <GuardianSettingsPopover
              review={selectorValue}
              correction={correction}
              presets={presets}
              quotas={quotas}
              autoReview={Boolean(conversation.auto_review)}
              target={target}
              busy={busy}
              onReviewChange={(next) => { setSelection(next); void save(next) }}
              onCorrectionChange={selectCorrection}
              onAutoReviewChange={(enabled) => void save(selection, enabled)}
            />
          ) : null}
        </div>
      </div>
      {expanded && openFlags.length > 0 ? (
        <div className={`guardian-findings is-${variant}`} id="guardian-findings">
          {visibleFlags.map((flag) => <FindingPreview key={flag.id} flag={flag} onOpenCode={onOpenCode} onCorrect={() => void correct(flag)} onAcknowledge={() => void acknowledge(flag)} />)}
          {openFlags.length > visibleFlags.length ? <button type="button" className="guardian-findings-more" onClick={() => onOpenCode()}>+ {openFlags.length - visibleFlags.length} autre{openFlags.length - visibleFlags.length > 1 ? 's' : ''} — ouvrir dans Code</button> : null}
        </div>
      ) : null}
      {error ? <p className="conversation-review-error" role="alert">{error}</p> : null}
    </section>
  )
}
