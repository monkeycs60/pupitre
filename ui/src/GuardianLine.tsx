import { useCallback, useEffect, useRef, useState } from 'react'
import { dispatchAllFlags, dispatchGroupedFlags, getConversationDiff, listProjectReviews } from './api'
import { isScanRunning } from './reviewStatus'
import type { Conversation, Project, Review, ReviewStatusSnapshot } from './types'

interface GuardianLineProps {
  conversation: Conversation
  project: Project
  reviewStatus: ReviewStatusSnapshot | null
  onOpenCode: (flagId?: string) => void
  onRelire: () => void
}

type Variant = 'idle' | 'running' | 'clean' | 'warn' | 'block' | 'stale'
type CorrectionMode = 'grouped' | 'individual'

function GuardianShield() {
  return <svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden="true"><path d="M8 2 13 4v4c0 3-2 5-5 6-3-1-5-3-5-6V4l5-2Z" /></svg>
}

function openFlagsOf(review: Review) {
  return review.flags.filter((flag) => flag.status === 'open' || flag.status === 'agent_running')
}

function variantFor(review: Review | null, running: boolean, stale: boolean): Variant {
  if (running) return 'running'
  if (!review) return 'idle'
  if (review.status === 'error') return 'block'
  const open = openFlagsOf(review)
  // Un signalement rouge encore ouvert reste vrai même si le diff a bougé :
  // le neutre de `stale` ne doit pas l'effacer de l'écran.
  if (open.some((flag) => flag.severity === 'red')) return 'block'
  if (stale) return 'stale'
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

function stateLabel(review: Review | null, stale: boolean): string {
  if (!review) return 'pas encore relu'
  if (review.status === 'error') return 'relecture interrompue'
  if (!stale) return findingsSummary(review)
  if (openFlagsOf(review).length === 0) return 'à relire'
  return `${findingsSummary(review)} · à relire`
}

export function GuardianLine({ conversation, project, reviewStatus, onOpenCode, onRelire }: GuardianLineProps) {
  const [review, setReview] = useState<Review | null>(null)
  const [liveDiff, setLiveDiff] = useState<string | null>(null)
  const [correcting, setCorrecting] = useState(false)
  const [correctionMode, setCorrectionMode] = useState<CorrectionMode>('grouped')
  const [correctionError, setCorrectionError] = useState<string | null>(null)
  const running = isScanRunning(reviewStatus)
  const wasRunning = useRef(running)

  // Les deux appels sont indépendants : un diff en échec ne doit pas masquer
  // une review disponible, et inversement.
  const loadReview = useCallback((signal?: AbortSignal) => {
    void listProjectReviews(project.id, signal)
      .then((reviews) => {
        if (signal?.aborted) return
        setReview(reviews.find((item) => item.conversation_id === conversation.id && item.scope === 'worktree' && item.status !== 'running') ?? null)
      })
      .catch(() => {})
    void getConversationDiff(conversation.id, signal)
      .then((live) => {
        if (signal?.aborted) return
        setLiveDiff(live.diff)
      })
      .catch(() => {})
  }, [project.id, conversation.id])

  useEffect(() => {
    function onVisible() { if (document.visibilityState === 'visible') loadReview() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
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
  // ligne ne doit pas rester verte sur un diff que le Gardien n'a pas lu.
  const stale = review !== null && review.status === 'done' && liveDiff !== null && review.diff_text !== liveDiff
  const label = running && reviewStatus?.running
    ? `relit · zone ${reviewStatus.running.zoneDone}/${reviewStatus.running.zoneTotal}`
    : stateLabel(review, stale)
  const variant = variantFor(review, running, stale)
  const openFlags = review?.flags.filter((flag) => flag.status === 'open') ?? []

  async function correctOpenFlags() {
    if (!review || openFlags.length === 0 || correcting) return
    const confirmation = correctionMode === 'grouped'
      ? `Lancer une correction groupée pour ${openFlags.length} erreur${openFlags.length > 1 ? 's' : ''} avec un seul agent ?`
      : `Lancer ${openFlags.length} agents, un par erreur ?`
    if (!window.confirm(confirmation)) return
    setCorrecting(true)
    setCorrectionError(null)
    try {
      if (correctionMode === 'grouped') {
        await dispatchGroupedFlags(review.id, ['red', 'orange', 'grey'])
      } else {
        await dispatchAllFlags(review.id, ['red', 'orange', 'grey'])
      }
      const dispatchedIds = new Set(openFlags.map((flag) => flag.id))
      setReview((current) => current === null ? null : {
        ...current,
        flags: current.flags.map((flag) => dispatchedIds.has(flag.id)
          ? { ...flag, status: 'agent_running' }
          : flag),
      })
    } catch (reason) {
      setCorrectionError(reason instanceof Error ? reason.message : 'Impossible de lancer les corrections')
    } finally {
      setCorrecting(false)
    }
  }

  return <div className={`guardian-line is-${variant}`} id="guardian-line" role="group" aria-label="Gardien">
    <span className="guardian-line-status" aria-hidden="true">
      {running ? <span className="guardian-line-dots"><i /><i /><i /></span> : <GuardianShield />}
    </span>
    <strong className="guardian-line-title">Gardien</strong>
    <span className="guardian-line-meta" title={correctionError ?? (stale ? 'Le diff a changé depuis la relecture.' : undefined)}>{correctionError ?? label}</span>
    <button type="button" className="guardian-line-action" onClick={onRelire} disabled={running}>Relire</button>
    {openFlags.length > 0 ? (
      <div className="guardian-line-correction">
        <button
          type="button"
          className="guardian-line-action guardian-line-correction-button"
          aria-label={openFlags.length === 1 ? 'Corriger l’erreur' : `Corriger les ${openFlags.length} erreurs`}
          onClick={() => void correctOpenFlags()}
          disabled={running || correcting}
        >
          {correcting ? 'Lancement…' : 'Corriger'}
        </button>
        {openFlags.length > 1 ? (
          <select
            className="guardian-line-correction-mode"
            aria-label="Mode de correction"
            value={correctionMode}
            onChange={(event) => setCorrectionMode(event.target.value as CorrectionMode)}
            disabled={running || correcting}
            title="Correction groupée : un seul agent. Une par erreur : un agent par signalement."
          >
            <option value="grouped">Ensemble · 1 agent</option>
            <option value="individual">Séparément · {openFlags.length} agents</option>
          </select>
        ) : null}
      </div>
    ) : null}
    <button type="button" className="guardian-line-action" onClick={() => onOpenCode()}>Ouvrir le code</button>
  </div>
}
