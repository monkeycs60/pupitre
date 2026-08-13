import { useEffect, useMemo, useState } from 'react'
import { listPresets, listProjectReviews, setConversationReviewConfig, startReview } from './api'
import { REVIEW_MODELS } from './modelOptions'
import { buildFileTree } from './reviewFileTree'
import { ReviewConfigSelector, reviewPreset } from './ReviewConfigSelector'
import type { ReviewSelection } from './ReviewConfigSelector'
import type { Conversation, Preset, Project, Provider, QuotaSnapshot, Review, ReviewStatusSnapshot } from './types'

interface Props {
  conversation: Conversation
  project: Project
  reviewStatus: ReviewStatusSnapshot | null
  onConversationUpdated: (conversation: Conversation) => void
  onOpenCode: () => void
  quotas: QuotaSnapshot
}

function initialProvider(conversation: Conversation): Provider {
  return conversation.review_provider ?? conversation.provider
}

export function ConversationReviewPanel({
  conversation,
  project,
  reviewStatus,
  onConversationUpdated,
  onOpenCode,
  quotas,
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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    void listPresets(controller.signal).then(setPresets).catch(() => {})
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    const refresh = () => {
      void listProjectReviews(project.id, controller.signal)
        .then((items) => setReview(items.find((item) => item.conversation_id === conversation.id) ?? null))
        .catch((cause) => {
          if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Review indisponible')
        })
    }
    refresh()
    const timer = reviewStatus?.running ? window.setInterval(refresh, 1_500) : null
    return () => {
      controller.abort()
      if (timer !== null) window.clearInterval(timer)
    }
  }, [conversation.id, project.id, reviewStatus?.running?.reviewId])

  const files = useMemo(
    () => review ? buildFileTree(review.diff_text, review.flags) : [],
    [review],
  )
  const openFlags = review?.flags.filter((flag) => !['treated', 'ignored', 'resolved'].includes(flag.status)) ?? []
  const runningHere = reviewStatus?.running?.reviewId === review?.id || review?.status === 'running'
  const inferredPreset = presets.find((preset) => {
    const config = reviewPreset(preset)
    return config.provider === selection.provider
      && config.model === selection.model
      && config.effort === selection.effort
      && (selection.provider !== 'codex' || (config.speed ?? 'standard') === selection.speed)
  })
  const selectorValue = { ...selection, presetId: selection.presetId || inferredPreset?.id || '' }

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

  return (
    <section className={`conversation-review${review && review.status === 'done' && openFlags.length === 0 ? ' is-clear' : ''}`} id="conversation-review-panel" aria-label="Review Gardien">
      {toast ? <div className="conversation-review-toast" role="alert"><span>{toast}</span><button type="button" onClick={() => setToast(null)} aria-label="Fermer la notification">×</button></div> : null}
      <div className="conversation-review-head">
        <span className="conversation-review-shield" aria-hidden="true">◇</span>
        <div><strong>Gardien</strong><span>Conversation → worktree</span></div>
        <label className="conversation-review-auto" title="Déclenche une review après chaque tour réussi, au maximum une fois par minute.">
          <input type="checkbox" checked={Boolean(conversation.auto_review)} onChange={(event) => void save(selection, event.target.checked)} />
          <span>Auto après chaque tour</span>
        </label>
      </div>
      <div className="conversation-review-controls">
        <ReviewConfigSelector value={selectorValue} presets={presets} quotas={quotas} busy={busy} onChange={(next) => { setSelection(next); void save(next) }} />
        <button type="button" className="conversation-review-run" onClick={() => void launch()} disabled={busy || Boolean(reviewStatus?.running)}>{busy ? 'Lancement…' : runningHere && reviewStatus?.running ? `Analyse ${reviewStatus.running.zoneDone}/${reviewStatus.running.zoneTotal}` : 'Relire maintenant'}</button>
      </div>
      {error ? <p className="conversation-review-error" role="alert">{error}</p> : null}
      {review?.status === 'error' ? (
        <div className="conversation-review-result has-error" role="status">
          <span>Review interrompue</span>
          <span>{review.error ?? 'Le scan n’a pas pu se terminer.'}</span>
          <button type="button" onClick={() => void launch()}>Réessayer</button>
        </div>
      ) : review?.status === 'done' ? (
        <div className="conversation-review-result">
          <span className={openFlags.length ? 'has-flags' : 'is-clear'}>{openFlags.length ? `${openFlags.length} signalement${openFlags.length > 1 ? 's' : ''}` : '✓ Review conforme'}</span>
          <span>{openFlags.length ? '' : 'Aucun signalement · '}{files.length} fichier{files.length > 1 ? 's' : ''} analysé{files.length > 1 ? 's' : ''}</span>
          {openFlags.slice(0, 2).map((flag) => <span className={`review-preview-flag risk-${flag.severity}`} key={flag.id}>{flag.file}:{flag.line_start} · {flag.message}</span>)}
          <button type="button" onClick={onOpenCode}>Ouvrir le diff</button>
        </div>
      ) : <p className="conversation-review-hint">À la demande, ou automatiquement après un tour réussi · délai minimum 1 min.</p>}
    </section>
  )
}
