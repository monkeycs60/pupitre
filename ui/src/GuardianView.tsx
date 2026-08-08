import { useEffect, useRef, useState } from 'react'
import {
  getGardienStatus,
  listProjectReviews,
  setProjectGardienMode,
  setProjectAutoCounterRed,
  setReviewFlagCodeProvider,
  setReviewDecisionStatus,
} from './api'
import { CounterOpinionDialog } from './CounterOpinionDialog'
import { DiffViewer } from './DiffViewer'
import type {
  GardienMode,
  GardienStatus,
  Project,
  Review,
  ReviewDecision,
  ReviewFlag,
  ReviewSeverity,
} from './types'
import { HelpLink } from './HelpLink'

interface GuardianViewProps {
  project: Project
  initialReviewId: string | null
  refreshToken: number
  onProjectUpdated: (project: Project) => void
  onReviewsChanged: () => void
  onStartReview?: () => void
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

const SEVERITY_LABEL: Record<ReviewSeverity, string> = {
  red: 'rouge',
  orange: 'orange',
  grey: 'gris',
}

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

const SEVERITY_RANK: Record<ReviewSeverity, number> = { red: 2, orange: 1, grey: 0 }

function worstSeverity(flags: ReviewFlag[]): ReviewSeverity {
  return flags.reduce<ReviewSeverity>(
    (worst, flag) => SEVERITY_RANK[flag.severity] > SEVERITY_RANK[worst] ? flag.severity : worst,
    'grey',
  )
}

function diffStats(diffText: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) added += 1
    else if (line.startsWith('-')) removed += 1
  }
  return { added, removed }
}

type SeverityFilter = 'red' | 'orange' | 'acked' | null

function decisionStatusLabel(decision: ReviewDecision, flags: ReviewFlag[]): string {
  if (decision.status === 'acked') return 'Acquittée'
  if (decision.status === 'dismissed') return 'Écartée'
  if (flags.some((flag) => flag.counter_state === 'running')) return 'Contre-avis en cours'
  if (flags.some((flag) => flag.counter_state === 'queued')) return 'Contre-avis en attente'
  return 'Ouverte'
}

export function GuardianView({
  project,
  initialReviewId,
  refreshToken,
  onProjectUpdated,
  onReviewsChanged,
  onStartReview,
}: GuardianViewProps) {
  const [reviews, setReviews] = useState<Review[]>([])
  const [selectedId, setSelectedId] = useState(initialReviewId)
  const [gardienStatus, setGardienStatus] = useState<GardienStatus>({
    mode: project.gardien_mode,
    blocked: false,
    openRedCount: 0,
    openFlagCount: 0,
    pendingReviewCount: 0,
  })
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [counterTarget, setCounterTarget] = useState<ReviewFlag | 'all' | null>(null)
  const [selectedDecisionId, setSelectedDecisionId] = useState<string | null>(null)
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>(null)
  const hadActiveReview = useRef(false)

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
        const hasActiveReview = loadedReviews.some((review) =>
          review.status === 'running' || review.flags.some((flag) =>
            flag.counter_state === 'queued' || flag.counter_state === 'running',
          ),
        )
        if (hadActiveReview.current && !hasActiveReview) onReviewsChanged()
        hadActiveReview.current = hasActiveReview
        if (hasActiveReview) {
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
  }, [onReviewsChanged, project.id, refreshToken])

  const selected = reviews.find((review) => review.id === selectedId) ?? null
  const pendingCount = reviews.filter(pending).length

  const selectedOpenFlags = selected
    ? selected.flags.filter((flag) => flag.status === 'open' || flag.status === 'countered')
    : []
  const redCount = selectedOpenFlags.filter((flag) => flag.severity === 'red').length
  const orangeCount = selectedOpenFlags.filter((flag) => flag.severity === 'orange').length
  const ackedCount = selected
    ? selected.flags.filter((flag) => flag.status === 'acked' || flag.status === 'dismissed').length
    : 0

  const filteredDecisions = (selected?.decisions ?? []).filter((decision) => {
    const flagsOf = selected!.flags.filter((flag) => decision.flag_ids.includes(flag.id))
    if (severityFilter === 'red') return flagsOf.some((flag) => flag.severity === 'red')
    if (severityFilter === 'orange') return flagsOf.some((flag) => flag.severity === 'orange')
    if (severityFilter === 'acked') return decision.status !== 'open'
    return true
  })

  const activeDecision = filteredDecisions.find((decision) => decision.id === selectedDecisionId)
    ?? filteredDecisions[0]
    ?? null
  const activeDecisionFlags = activeDecision
    ? (selected?.flags ?? []).filter((flag) => activeDecision.flag_ids.includes(flag.id))
    : []
  const { added, removed } = selected ? diffStats(selected.diff_text) : { added: 0, removed: 0 }

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

  async function handleDecisionStatus(
    decision: ReviewDecision,
    status: 'acked' | 'dismissed',
  ) {
    setError(null)
    try {
      const updated = await setReviewDecisionStatus(decision.id, status)
      setReviews((current) => current.map((review) => ({
        ...review,
        decisions: review.decisions.map((item) => item.id === updated.id ? updated : item),
        flags: review.flags.map((flag) =>
          updated.flag_ids.includes(flag.id) ? { ...flag, status } : flag,
        ),
      })))
      setGardienStatus(await getGardienStatus(project.id))
      onReviewsChanged()
    } catch (updateError: unknown) {
      setError(errorMessage(updateError))
    }
  }

  async function handleFlagCodeProvider(flag: ReviewFlag, codeProvider: 'claude' | 'codex') {
    setError(null)
    try {
      const updated = await setReviewFlagCodeProvider(flag.id, codeProvider)
      setReviews((current) => current.map((review) => ({
        ...review,
        flags: review.flags.map((item) => item.id === updated.id ? updated : item),
      })))
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
      {gardienStatus.blocked ? (
        <div className="guardian-blocking" role="alert">
          Validation bloquée visuellement : {gardienStatus.openRedCount} point
          {gardienStatus.openRedCount === 1 ? '' : 's'} rouge
          {gardienStatus.openRedCount === 1 ? ' reste' : ' restent'} à acquitter.
        </div>
      ) : null}
      {error ? <div className="guardian-error" role="alert">{error}</div> : null}

      <div className="guardian-layout">
        <aside className="guardian-sidebar" aria-label="Flags Gardien">
          <div className="guardian-sidebar-header">
            <div className="guardian-title-row">
              <h1>Gardien</h1>
              {selectedOpenFlags.length > 0 ? (
                <span className="guardian-open-pill">
                  {selectedOpenFlags.length} ouverte{selectedOpenFlags.length === 1 ? '' : 's'}
                </span>
              ) : null}
              <HelpLink slug="gardien" />
            </div>
            <p className="guardian-subtitle">
              {project.name}
              {selected ? ` · ${shortRef(selected.git_ref_base)} → ${shortRef(selected.git_ref_head)}` : ''}
              {' · '}
              {pendingCount} review{pendingCount === 1 ? '' : 's'} à traiter
            </p>

            {reviews.length > 1 ? (
              <select
                className="guardian-review-select"
                value={selectedId ?? ''}
                onChange={(event) => setSelectedId(event.target.value)}
              >
                {reviews.map((review) => (
                  <option key={review.id} value={review.id}>
                    {shortRef(review.git_ref_base)} → {shortRef(review.git_ref_head)} · {reviewDate(review.created_at)}
                  </option>
                ))}
              </select>
            ) : null}

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

            <div className="guardian-severity-row">
              <button
                type="button"
                className={`guardian-severity-btn severity-red ${severityFilter === 'red' ? 'is-active' : ''}`}
                onClick={() => setSeverityFilter((current) => current === 'red' ? null : 'red')}
              >
                <span className="guardian-severity-count">{redCount}</span>
                <span className="guardian-severity-label">Rouge</span>
              </button>
              <button
                type="button"
                className={`guardian-severity-btn severity-orange ${severityFilter === 'orange' ? 'is-active' : ''}`}
                onClick={() => setSeverityFilter((current) => current === 'orange' ? null : 'orange')}
              >
                <span className="guardian-severity-count">{orangeCount}</span>
                <span className="guardian-severity-label">Orange</span>
              </button>
              <button
                type="button"
                className={`guardian-severity-btn severity-acked ${severityFilter === 'acked' ? 'is-active' : ''}`}
                onClick={() => setSeverityFilter((current) => current === 'acked' ? null : 'acked')}
              >
                <span className="guardian-severity-count">{ackedCount}</span>
                <span className="guardian-severity-label">Acquittées</span>
              </button>
            </div>
          </div>

          <div className="guardian-flag-list">
            {isLoading ? <p className="guardian-empty">Chargement…</p> : null}
            {!isLoading && reviews.length === 0 ? (
              <div className="guardian-empty">
                <p>Aucune review.</p>
                <span>
                  {onStartReview
                    ? 'Relisez directement les changements de la conversation ouverte, puis ajustez le scope seulement si nécessaire.'
                    : 'Ouvrez une conversation puis lancez « Review Gardien » pour analyser le dernier diff Git et ancrer les risques aux lignes concernées.'}
                </span>
                {onStartReview ? (
                  <button type="button" className="header-action guardian-empty-action" onClick={onStartReview}>
                    Relire les changements actuels
                  </button>
                ) : null}
              </div>
            ) : null}
            {!isLoading && selected && selected.decisions.length === 0 ? (
              <p className="guardian-empty">
                {selected.status === 'done'
                  ? 'Aucune décision à acquitter pour cette review.'
                  : 'Les décisions apparaîtront à la fin du scan.'}
              </p>
            ) : null}
            {selected ? filteredDecisions.map((decision) => {
              const flagsOf = selected.flags.filter((flag) => decision.flag_ids.includes(flag.id))
              const severity = worstSeverity(flagsOf)
              const location = flagsOf.length === 1
                ? `${flagsOf[0].file}:${flagsOf[0].line_start}`
                : `${flagsOf.length} emplacements`
              const acquitted = decision.status !== 'open'
              return (
                <button
                  type="button"
                  key={decision.id}
                  className={`guardian-flag-card severity-${severity} ${
                    activeDecision?.id === decision.id ? 'is-selected' : ''
                  } ${acquitted ? 'is-acquitted' : ''}`}
                  onClick={() => setSelectedDecisionId(decision.id)}
                >
                  <div className="guardian-flag-card-row">
                    <span className="guardian-flag-severity">{SEVERITY_LABEL[severity]}</span>
                    <span className="guardian-flag-where">{location}</span>
                  </div>
                  <div className="guardian-flag-text">{decision.question}</div>
                  <div className="guardian-flag-status">{decisionStatusLabel(decision, flagsOf)}</div>
                </button>
              )
            }) : null}
          </div>
        </aside>

        <section className="guardian-main" aria-label="Diff thermique">
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
            <>
              <div className="guardian-main-header">
                <span className="guardian-main-title">
                  {shortRef(selected.git_ref_base)} → {shortRef(selected.git_ref_head)}
                </span>
                <span className="guardian-diff-added">+{added}</span>
                <span className="guardian-diff-removed">−{removed}</span>
                <div className="guardian-main-header-spacer" />
                {selected.flags.length > 0 ? (
                  <button type="button" onClick={() => setCounterTarget('all')}>
                    Contre-avis global
                  </button>
                ) : null}
              </div>
              <div className="guardian-main-body">
                <div className="guardian-diff-panel">
                  <DiffViewer diff={selected.diff_text} flags={selected.flags} label="Diff annoté" />

                  {activeDecision ? (
                    <article className={`guardian-decision is-${activeDecision.status}`}>
                      <p className="guardian-decision-question">{activeDecision.question}</p>
                      {activeDecisionFlags.map((flag) => (
                        <div className={`decision-flag severity-${flag.severity}`} key={flag.id}>
                          <header>
                            <span className="decision-flag-severity">{SEVERITY_LABEL[flag.severity]}</span>
                            <span className="decision-flag-location">{flag.file}:{flag.line_start}</span>
                          </header>
                          <p>{flag.message}</p>
                          <label className="decision-flag-author">
                            <span>Auteur du code</span>
                            <select
                              value={flag.code_provider}
                              disabled={flag.counter_state === 'queued' || flag.counter_state === 'running'}
                              onChange={(event) => void handleFlagCodeProvider(
                                flag,
                                event.target.value as 'claude' | 'codex',
                              )}
                            >
                              <option value="codex">codex</option>
                              <option value="claude">claude</option>
                            </select>
                          </label>
                          {flag.counter_state === 'queued' || flag.counter_state === 'running' ? (
                            <p className={`counter-opinion-state is-${flag.counter_state}`}>
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
                          <div className="guardian-decision-actions">
                            <button
                              type="button"
                              className="counter-opinion-action"
                              onClick={() => setCounterTarget(flag)}
                              disabled={flag.counter_state === 'queued' || flag.counter_state === 'running'}
                            >
                              {flag.counter_state === 'done' ? 'Redemander un contre-avis' : 'Contre-avis ciblé'}
                            </button>
                          </div>
                        </div>
                      ))}
                      <div className="review-decision-actions">
                        {activeDecision.status === 'open' ? (
                          <>
                            <button type="button" onClick={() => void handleDecisionStatus(activeDecision, 'acked')}>
                              Acquitter cette décision
                            </button>
                            <button type="button" onClick={() => void handleDecisionStatus(activeDecision, 'dismissed')}>
                              Écarter
                            </button>
                          </>
                        ) : (
                          <span className="review-decision-status">
                            {activeDecision.status === 'acked' ? 'Acquittée' : 'Écartée'}
                          </span>
                        )}
                      </div>
                    </article>
                  ) : null}
                </div>
              </div>
            </>
          )}
        </section>
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
