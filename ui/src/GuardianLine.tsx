import { useCallback, useEffect, useRef, useState } from 'react'
import { listProjectReviews } from './api'
import { isScanRunning } from './reviewStatus'
import type { Conversation, Project, Review, ReviewStatusSnapshot } from './types'

interface GuardianLineProps {
  conversation: Conversation
  project: Project
  reviewStatus: ReviewStatusSnapshot | null
  onOpenCode: (flagId?: string) => void
  onRelire: () => void
}

type Variant = 'idle' | 'running' | 'clean' | 'warn' | 'block'

function GuardianShield() {
  return <svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden="true"><path d="M8 2 13 4v4c0 3-2 5-5 6-3-1-5-3-5-6V4l5-2Z" /></svg>
}

function variantFor(review: Review | null, running: boolean): Variant {
  if (running) return 'running'
  if (!review) return 'idle'
  if (review.status === 'error') return 'block'
  const open = review.flags.filter((flag) => flag.status === 'open' || flag.status === 'agent_running')
  if (open.length === 0) return 'clean'
  return open.some((flag) => flag.severity === 'red') ? 'block' : 'warn'
}

/** Compte des flags encore ouverts, un mot par sévérité non nulle. */
function findingsSummary(review: Review): string {
  const open = review.flags.filter((flag) => flag.status === 'open' || flag.status === 'agent_running')
  if (open.length === 0) return 'rien à signaler'
  const bySeverity = (severity: 'red' | 'orange' | 'grey', word: string) => {
    const count = open.filter((flag) => flag.severity === severity).length
    return count > 0 ? `${count} ${word}${count > 1 ? 's' : ''}` : null
  }
  return [bySeverity('red', 'rouge'), bySeverity('orange', 'orange'), bySeverity('grey', 'gris')]
    .filter((part): part is string => part !== null)
    .join(' · ')
}

function stateLabel(review: Review | null): string {
  if (!review) return 'pas encore relu'
  if (review.status === 'error') return 'relecture interrompue'
  return findingsSummary(review)
}

export function GuardianLine({ conversation, project, reviewStatus, onOpenCode, onRelire }: GuardianLineProps) {
  const [review, setReview] = useState<Review | null>(null)
  const running = isScanRunning(reviewStatus)
  const wasRunning = useRef(running)

  const loadReview = useCallback((signal?: AbortSignal) => {
    void listProjectReviews(project.id, signal)
      .then((reviews) => {
        if (signal?.aborted) return
        setReview(reviews.find((item) => item.conversation_id === conversation.id && item.scope === 'worktree') ?? null)
      })
      .catch(() => {})
  }, [project.id, conversation.id])

  useEffect(() => {
    const controller = new AbortController()
    loadReview(controller.signal)
    return () => controller.abort()
  }, [loadReview])

  useEffect(() => {
    if (wasRunning.current && !running) loadReview()
    wasRunning.current = running
  }, [running, loadReview])

  const label = running && reviewStatus?.running
    ? `relit · zone ${reviewStatus.running.zoneDone}/${reviewStatus.running.zoneTotal}`
    : stateLabel(review)
  const variant = variantFor(review, running)

  return <div className={`guardian-line is-${variant}`} id="guardian-line" role="group" aria-label="Gardien">
    <span className="guardian-line-status" aria-hidden="true">
      {running ? <span className="guardian-line-dots"><i /><i /><i /></span> : <GuardianShield />}
    </span>
    <strong className="guardian-line-title">Gardien</strong>
    <span className="guardian-line-meta">{label}</span>
    <button type="button" className="guardian-line-action" onClick={onRelire} disabled={running}>Relire</button>
    <button type="button" className="guardian-line-action" onClick={() => onOpenCode()}>Ouvrir le code</button>
  </div>
}
