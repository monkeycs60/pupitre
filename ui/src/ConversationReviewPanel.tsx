import { useEffect, useMemo, useState } from 'react'
import { listProjectReviews, setConversationReviewConfig, startReview } from './api'
import { PROVIDER_EFFORTS, REVIEW_MODELS, modelLabel } from './modelOptions'
import { buildFileTree } from './reviewFileTree'
import type { Conversation, Project, Provider, Review, ReviewStatusSnapshot } from './types'

interface Props {
  conversation: Conversation
  project: Project
  reviewStatus: ReviewStatusSnapshot | null
  onConversationUpdated: (conversation: Conversation) => void
  onOpenCode: () => void
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
}: Props) {
  const initial = initialProvider(conversation)
  const [provider, setProvider] = useState<Provider>(initial)
  const [model, setModel] = useState(conversation.review_model ?? REVIEW_MODELS[initial][0])
  const [effort, setEffort] = useState(conversation.review_effort ?? 'high')
  const [review, setReview] = useState<Review | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  async function save(next: { enabled?: boolean, provider?: Provider, model?: string, effort?: string }) {
    const nextProvider = next.provider ?? provider
    const nextModel = next.model ?? model
    const nextEffort = next.effort ?? effort
    setError(null)
    try {
      const updated = await setConversationReviewConfig(conversation.id, {
        enabled: next.enabled ?? Boolean(conversation.auto_review),
        reviewProvider: nextProvider,
        reviewModel: nextModel,
        reviewEffort: nextEffort,
      })
      onConversationUpdated(updated)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Réglage impossible')
    }
  }

  async function launch() {
    setBusy(true)
    setError(null)
    try {
      const started = await startReview({
        conversationId: conversation.id,
        scope: 'worktree',
        gitRefBase: 'CONVERSATION',
        gitRefHead: 'WORKTREE',
        reviewProvider: provider,
        reviewModel: model,
        reviewEffort: effort,
        codeProvider: conversation.provider,
      })
      setReview(started)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Review impossible')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="conversation-review" id="conversation-review-panel" aria-label="Review Gardien">
      <div className="conversation-review-head">
        <span className="conversation-review-shield" aria-hidden="true">◇</span>
        <div><strong>Gardien</strong><span>Conversation → worktree</span></div>
        <label className="conversation-review-auto" title="Déclenche une review après chaque tour réussi, au maximum une fois par minute.">
          <input type="checkbox" checked={Boolean(conversation.auto_review)} onChange={(event) => void save({ enabled: event.target.checked })} />
          <span>Auto après chaque tour</span>
        </label>
      </div>
      <div className="conversation-review-controls">
        <label><span>Agent</span><select value={provider} onChange={(event) => {
          const next = event.target.value as Provider
          const nextModel = REVIEW_MODELS[next][0]
          setProvider(next); setModel(nextModel); setEffort('high')
          void save({ provider: next, model: nextModel, effort: 'high' })
        }}><option value="codex">Codex</option><option value="claude">Claude</option></select></label>
        <label><span>Modèle</span><select value={model} onChange={(event) => { setModel(event.target.value); void save({ model: event.target.value }) }}>{REVIEW_MODELS[provider].map((item) => <option key={item} value={item}>{modelLabel(item)}</option>)}</select></label>
        <label><span>Effort</span><select value={effort} onChange={(event) => { setEffort(event.target.value); void save({ effort: event.target.value }) }}>{PROVIDER_EFFORTS[provider].map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        <button type="button" className="conversation-review-run" onClick={() => void launch()} disabled={busy || Boolean(reviewStatus?.running)}>{busy ? 'Lancement…' : runningHere && reviewStatus?.running ? `Analyse ${reviewStatus.running.zoneDone}/${reviewStatus.running.zoneTotal}` : 'Relire maintenant'}</button>
      </div>
      {error ? <p className="conversation-review-error" role="alert">{error}</p> : null}
      {review && review.status !== 'running' ? (
        <div className="conversation-review-result">
          <span className={openFlags.length ? 'has-flags' : 'is-clear'}>{openFlags.length ? `${openFlags.length} signalement${openFlags.length > 1 ? 's' : ''}` : 'Aucun signalement'}</span>
          <span>{files.length} fichier{files.length > 1 ? 's' : ''} analysé{files.length > 1 ? 's' : ''}</span>
          {openFlags.slice(0, 2).map((flag) => <span className={`review-preview-flag risk-${flag.severity}`} key={flag.id}>{flag.file}:{flag.line_start} · {flag.message}</span>)}
          <button type="button" onClick={onOpenCode}>Ouvrir le diff</button>
        </div>
      ) : <p className="conversation-review-hint">À la demande, ou automatiquement après un tour réussi · délai minimum 1 min.</p>}
    </section>
  )
}
