import { useEffect, useMemo, useState } from 'react'
import {
  getGardienStatus,
  listProjectReviews,
  setProjectGardienMode,
  setProjectAutoCounterRed,
  setReviewFlagStatus,
} from './api'
import { CounterOpinionDialog } from './CounterOpinionDialog'
import { parseUnifiedDiff } from './reviewDiff'
import type {
  GardienMode,
  GardienStatus,
  Project,
  Review,
  ReviewFlag,
} from './types'

interface GuardianViewProps {
  project: Project
  initialReviewId: string | null
  refreshToken: number
  onProjectUpdated: (project: Project) => void
  onReviewsChanged: () => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Le Gardien est indisponible.'
}

function pending(review: Review): boolean {
  return review.status === 'running' || review.flags.some((flag) =>
    flag.status === 'open' || flag.status === 'countered'
      || flag.counter_state === 'queued' || flag.counter_state === 'running',
  )
}

const VERDICT_LABEL = {
  confirmed: 'Risque confirmé',
  dismissed: 'Risque infirmé',
  nuanced: 'Risque nuancé',
} as const

function shortRef(ref: string): string {
  return /^[0-9a-f]{40}$/i.test(ref) ? ref.slice(0, 8) : ref
}

function reviewDate(value: string): string {
  return new Intl.DateTimeFormat('fr-FR', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

export function GuardianView({
  project,
  initialReviewId,
  refreshToken,
  onProjectUpdated,
  onReviewsChanged,
}: GuardianViewProps) {
  const [reviews, setReviews] = useState<Review[]>([])
  const [selectedId, setSelectedId] = useState(initialReviewId)
  const [gardienStatus, setGardienStatus] = useState<GardienStatus>({
    mode: project.gardien_mode,
    blocked: false,
    openRedCount: 0,
  })
  const [expandedFlagId, setExpandedFlagId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [counterTarget, setCounterTarget] = useState<ReviewFlag | 'all' | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    let pollTimer: ReturnType<typeof setTimeout> | undefined

    async function load() {
      try {
        const [loadedReviews, status] = await Promise.all([
          listProjectReviews(project.id, controller.signal),
          getGardienStatus(project.id, controller.signal),
        ])
        if (controller.signal.aborted) return
        setReviews(loadedReviews)
        setGardienStatus(status)
        setSelectedId((current) => {
          if (current && loadedReviews.some((review) => review.id === current)) return current
          return loadedReviews[0]?.id ?? null
        })
        setError(null)
        setIsLoading(false)
        if (loadedReviews.some((review) =>
          review.status === 'running' || review.flags.some((flag) =>
            flag.counter_state === 'queued' || flag.counter_state === 'running',
          ),
        )) {
          pollTimer = setTimeout(() => void load(), 1_000)
        }
      } catch (loadError: unknown) {
        if (!controller.signal.aborted) {
          setError(errorMessage(loadError))
          setIsLoading(false)
        }
      }
    }

    void load()
    return () => {
      controller.abort()
      clearTimeout(pollTimer)
    }
  }, [project.id, refreshToken])

  const selected = reviews.find((review) => review.id === selectedId) ?? null
  const lines = useMemo(
    () => parseUnifiedDiff(selected?.diff_text ?? '', selected?.flags ?? []),
    [selected],
  )
  const pendingCount = reviews.filter(pending).length

  async function handleModeChange(mode: GardienMode) {
    setError(null)
    try {
      const updated = await setProjectGardienMode(project.id, mode)
      onProjectUpdated(updated)
      setGardienStatus((current) => ({
        ...current,
        mode,
        blocked: mode === 'bloquant' && current.openRedCount > 0,
      }))
    } catch (updateError: unknown) {
      setError(errorMessage(updateError))
    }
  }

  async function handleFlagStatus(flag: ReviewFlag, status: 'acked' | 'dismissed') {
    setError(null)
    try {
      const updated = await setReviewFlagStatus(flag.id, status)
      setReviews((current) => current.map((review) => ({
        ...review,
        flags: review.flags.map((item) => item.id === updated.id ? updated : item),
      })))
      setGardienStatus(await getGardienStatus(project.id))
      onReviewsChanged()
    } catch (updateError: unknown) {
      setError(errorMessage(updateError))
    }
  }

  async function handleAutoCounterChange(enabled: boolean) {
    setError(null)
    try {
      onProjectUpdated(await setProjectAutoCounterRed(project.id, enabled))
    } catch (updateError: unknown) {
      setError(errorMessage(updateError))
    }
  }

  return (
    <div className="guardian-workspace">
      <header className="guardian-header">
        <div>
          <h1>Gardien · {project.name}</h1>
          <p>{pendingCount} review{pendingCount === 1 ? '' : 's'} à traiter</p>
        </div>
        <div className="guardian-settings">
          <label className="guardian-auto-counter">
            <input
              type="checkbox"
              checked={project.auto_counter_red}
              onChange={(event) => void handleAutoCounterChange(event.target.checked)}
            />
            <span>Contre-avis auto sur rouge</span>
          </label>
          <label className="guardian-mode">
            <span>Mode</span>
            <select
              value={gardienStatus.mode}
              onChange={(event) => void handleModeChange(event.target.value as GardienMode)}
            >
              <option value="informatif">Informatif</option>
              <option value="bloquant">Bloquant</option>
            </select>
          </label>
        </div>
      </header>

      {gardienStatus.blocked ? (
        <div className="guardian-blocking" role="alert">
          Validation bloquée visuellement : {gardienStatus.openRedCount} point
          {gardienStatus.openRedCount === 1 ? '' : 's'} rouge
          {gardienStatus.openRedCount === 1 ? ' reste' : ' restent'} à acquitter.
        </div>
      ) : null}
      {error ? <div className="guardian-error" role="alert">{error}</div> : null}

      <div className="guardian-layout">
        <nav className="review-list" aria-label="Reviews Gardien">
          {isLoading ? <p className="guardian-empty">Chargement…</p> : null}
          {!isLoading && reviews.length === 0 ? (
            <div className="guardian-empty">
              <p>Aucune review.</p>
              <span>
                Ouvrez une conversation puis lancez « Review Gardien » pour analyser
                le dernier diff Git et ancrer les risques aux lignes concernées.
              </span>
            </div>
          ) : null}
          {reviews.map((review) => {
            const openFlags = review.flags.filter(
              (flag) => flag.status === 'open' || flag.status === 'countered',
            ).length
            return (
              <button
                type="button"
                key={review.id}
                className={`review-list-item ${selectedId === review.id ? 'is-selected' : ''}`}
                onClick={() => {
                  setSelectedId(review.id)
                  setExpandedFlagId(null)
                }}
              >
                <span className="review-list-title">
                  {shortRef(review.git_ref_base)} → {shortRef(review.git_ref_head)}
                </span>
                <span className="review-list-meta">
                  {review.status === 'running'
                    ? 'scan en cours'
                    : review.status === 'error'
                      ? 'échec'
                      : `${openFlags} point${openFlags === 1 ? '' : 's'} ouvert${openFlags === 1 ? '' : 's'}`}
                </span>
                <span className="review-list-meta">
                  {review.review_provider} · {review.review_model} · {reviewDate(review.created_at)}
                </span>
              </button>
            )
          })}
        </nav>

        <section className="review-diff" aria-label="Diff thermique">
          {selected === null ? (
            <div className="guardian-empty guardian-empty-main">
              Sélectionnez une review pour afficher son diff.
            </div>
          ) : selected.status === 'running' ? (
            <div className="guardian-empty guardian-empty-main">
              Le modèle relit les zones du diff. Cette vue se met à jour automatiquement.
            </div>
          ) : selected.status === 'error' ? (
            <div className="guardian-empty guardian-empty-main is-error">
              {selected.error ?? 'Le scan a échoué.'}
            </div>
          ) : selected.diff_text.trim() === '' ? (
            <div className="guardian-empty guardian-empty-main">
              Aucun changement entre ces deux références.
            </div>
          ) : (
            <div className="diff-table" role="table" aria-label="Diff annoté">
              {lines.map((line, index) => (
                <div
                  className={`diff-line is-${line.kind} ${line.severity ? `risk-${line.severity}` : ''}`}
                  role="row"
                  key={`${index}-${line.text}`}
                >
                  <span className="diff-number" role="cell">{line.oldLine ?? ''}</span>
                  <span className="diff-number" role="cell">{line.newLine ?? ''}</span>
                  <code role="cell">{line.text || ' '}</code>
                  <span className="diff-flags" role="cell">
                    {line.flags.map((flag) => (
                      <button
                        type="button"
                        key={flag.id}
                        className={`diff-flag-marker severity-${flag.severity}`}
                        onClick={() => setExpandedFlagId(
                          expandedFlagId === flag.id ? null : flag.id,
                        )}
                        title={`${flag.category} — ${flag.message}`}
                        aria-expanded={expandedFlagId === flag.id}
                      >
                        {expandedFlagId === flag.id ? flag.message : flag.category}
                      </button>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        <aside className="review-decisions" aria-label="Décisions ciblées">
          <div className="review-decisions-heading">
            <h2>Décisions</h2>
            {selected?.flags.length ? (
              <button type="button" onClick={() => setCounterTarget('all')}>
                Contre-avis global
              </button>
            ) : null}
          </div>
          {selected?.flags.length ? selected.flags.map((flag) => (
            <article className={`review-decision severity-${flag.severity}`} key={flag.id}>
              <header>
                <span>{flag.file}:{flag.line_start}</span>
                <span>{flag.severity}</span>
              </header>
              <p>{flag.message}</p>
              {flag.counter_state === 'queued' || flag.counter_state === 'running' ? (
                <p className="counter-opinion-state">
                  Contre-avis {flag.counter_state === 'queued' ? 'en attente' : 'en cours'} avec{' '}
                  {flag.counter_provider} · {flag.counter_model}
                </p>
              ) : null}
              {flag.counter_text && flag.counter_verdict ? (
                <div className={`counter-opinion verdict-${flag.counter_verdict}`}>
                  <strong>{VERDICT_LABEL[flag.counter_verdict]}</strong>
                  <p>{flag.counter_text}</p>
                  <span>{flag.counter_provider} · {flag.counter_model} · {flag.counter_effort}</span>
                </div>
              ) : null}
              {flag.counter_error ? (
                <p className="counter-opinion-error">Contre-avis échoué : {flag.counter_error}</p>
              ) : null}
              <div className="review-decision-actions">
                {flag.status === 'open' || flag.status === 'countered' ? (
                  <>
                    <button type="button" onClick={() => void handleFlagStatus(flag, 'acked')}>
                      Acquitter ce point
                    </button>
                    <button type="button" onClick={() => void handleFlagStatus(flag, 'dismissed')}>
                      Écarter
                    </button>
                  </>
                ) : (
                  <span>{flag.status === 'acked' ? 'Acquitté' : 'Écarté'}</span>
                )}
                <button
                  type="button"
                  onClick={() => setCounterTarget(flag)}
                  disabled={flag.counter_state === 'queued' || flag.counter_state === 'running'}
                >
                  {flag.counter_state === 'done' ? 'Redemander un contre-avis' : 'Contre-avis'}
                </button>
              </div>
            </article>
          )) : (
            <p className="guardian-empty">
              {selected?.status === 'done'
                ? 'Aucune décision à acquitter pour cette review.'
                : 'Les décisions apparaîtront à la fin du scan.'}
            </p>
          )}
        </aside>
      </div>
      {selected && counterTarget ? (
        <CounterOpinionDialog
          review={selected}
          flag={counterTarget === 'all' ? null : counterTarget}
          onClose={() => setCounterTarget(null)}
          onStarted={() => {
            setCounterTarget(null)
            onReviewsChanged()
          }}
        />
      ) : null}
    </div>
  )
}
