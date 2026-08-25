import { useCallback, useEffect, useRef, useState } from 'react'
import { getConversationDiff, listProjectReviews } from './api'
import { isScanRunning } from './reviewStatus'
import type { Conversation, Project, Review, ReviewStatusSnapshot } from './types'

interface GuardianLineProps {
  conversation: Conversation
  project: Project
  reviewStatus: ReviewStatusSnapshot | null
  onRelire: () => void
}

type Variant = 'idle' | 'running' | 'clean' | 'warn' | 'block' | 'stale'
type DiffState =
  | { status: 'pending' }
  | { status: 'error' }
  | { status: 'ready', diff: string }

function GuardianShield() {
  return <svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden="true"><path d="M8 2 13 4v4c0 3-2 5-5 6-3-1-5-3-5-6V4l5-2Z" /></svg>
}

function openFlagsOf(review: Review) {
  return review.flags.filter((flag) => flag.status === 'open' || flag.status === 'agent_running')
}

function variantFor(review: Review | null, running: boolean, unverified: boolean): Variant {
  if (running) return 'running'
  if (!review) return 'idle'
  if (review.status === 'error') return 'block'
  const open = openFlagsOf(review)
  // Un signalement rouge encore ouvert reste vrai même si le diff a bougé :
  // le neutre de `stale` ne doit pas l'effacer de l'écran.
  if (open.some((flag) => flag.severity === 'red')) return 'block'
  if (unverified) return 'stale'
  return open.length === 0 ? 'clean' : 'warn'
}

/** Compte des flags encore ouverts, un mot par sévérité non nulle. */
function findingsSummary(review: Review): string {
  const open = openFlagsOf(review)
  if (open.length === 0) return 'rien à signaler'
  const bySeverity = (severity: 'red' | 'orange' | 'grey', word: string) => {
    const count = open.filter((flag) => flag.severity === severity).length
    return count > 0 ? `${count} ${word}${count > 1 ? 's' : ''}` : null
  }
  return [bySeverity('red', 'rouge'), bySeverity('orange', 'orange'), bySeverity('grey', 'gris')]
    .filter((part): part is string => part !== null)
    .join(' · ')
}

function stateLabel(review: Review | null, verified: boolean, diffChanged: boolean): string {
  if (!review) return 'pas encore relu'
  if (review.status === 'error') return 'relecture interrompue'
  if (verified) return `✓ relu · ${findingsSummary(review)}`
  // Diff pas encore lu : ni quitus, ni péremption annoncée.
  if (!diffChanged) return findingsSummary(review)
  if (openFlagsOf(review).length === 0) return 'à relire'
  return `${findingsSummary(review)} · à relire`
}

export function GuardianLine({ conversation, project, reviewStatus, onRelire }: GuardianLineProps) {
  const [review, setReview] = useState<Review | null>(null)
  const [liveDiff, setLiveDiff] = useState<DiffState>({ status: 'pending' })
  const running = isScanRunning(reviewStatus)
  const wasRunning = useRef(running)
  // Focus et visibilité peuvent relancer un chargement pendant qu'un autre
  // vole encore : sans numéro d'ordre, la réponse la plus lente gagne.
  const loadSeq = useRef(0)

  // Les deux appels sont indépendants : un diff en échec ne doit pas masquer
  // une review disponible, et inversement.
  const loadReview = useCallback((signal?: AbortSignal) => {
    loadSeq.current += 1
    const seq = loadSeq.current
    const outdated = () => signal?.aborted === true || seq !== loadSeq.current
    void listProjectReviews(project.id, signal)
      .then((reviews) => {
        if (outdated()) return
        setReview(reviews.find((item) => item.conversation_id === conversation.id && item.scope === 'worktree' && item.status !== 'running') ?? null)
      })
      .catch(() => {})
    void getConversationDiff(conversation.id, signal)
      .then((live) => {
        if (outdated()) return
        setLiveDiff({ status: 'ready', diff: live.diff })
      })
      .catch(() => {
        if (outdated()) return
        setLiveDiff({ status: 'error' })
      })
  }, [project.id, conversation.id])

  useEffect(() => {
    const controller = new AbortController()
    function onVisible() { if (document.visibilityState === 'visible') loadReview(controller.signal) }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      controller.abort()
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [loadReview])

  useEffect(() => {
    const controller = new AbortController()
    loadReview(controller.signal)
    return () => controller.abort()
  }, [loadReview])

  useEffect(() => {
    if (wasRunning.current && !running) loadReview()
    wasRunning.current = running
  }, [running, loadReview])

  // Un commit ou une écriture après la relecture rend le verdict caduc : la
  // ligne ne doit pas rester verte sur un diff que le Gardien n'a pas lu. Un
  // diff qu'on n'a pas pu lire ne prouve rien non plus — pas plus qu'un diff
  // qu'on n'a pas encore chargé : le vert n'est mérité qu'après comparaison.
  const reviewedCurrentDiff = review?.status === 'done'
    && liveDiff.status === 'ready'
    && review.diff_text === liveDiff.diff
  const unverified = review !== null && review.status === 'done' && !reviewedCurrentDiff
  const diffChanged = unverified && liveDiff.status !== 'pending'
  const label = running && reviewStatus?.running
    ? `relit · zone ${reviewStatus.running.zoneDone}/${reviewStatus.running.zoneTotal}`
    : stateLabel(review, reviewedCurrentDiff, diffChanged)
  const variant = variantFor(review, running, unverified)
  return <div className={`guardian-line is-${variant}`} id="guardian-line" role="group" aria-label="Gardien">
    <span className="guardian-line-status" aria-hidden="true">
      {running ? <span className="guardian-line-dots"><i /><i /><i /></span> : <GuardianShield />}
    </span>
    <strong className="guardian-line-title">Gardien</strong>
    <span className="guardian-line-meta" title={diffChanged ? 'Le diff a changé depuis la relecture.' : reviewedCurrentDiff ? 'Déjà relu à ce stade précis.' : undefined}>{label}</span>
    <button type="button" className="guardian-line-action" onClick={onRelire} disabled={running}>Relire</button>
  </div>
}
