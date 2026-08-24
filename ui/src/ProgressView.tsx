import { useState } from 'react'
import type { TimeSnapshot } from './types'

interface ProgressViewProps {
  snapshot: TimeSnapshot | null
}

const HOUR_MS = 3_600_000

function formatDuration(milliseconds: number): string {
  const minutes = Math.floor(Math.max(0, milliseconds) / 60_000)
  const hours = Math.floor(minutes / 60)
  if (hours === 0) return `${minutes} min`
  return `${hours} h ${String(minutes % 60).padStart(2, '0')}`
}

function formatDate(iso: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })
}

function ratePerHour(count: number, ms: number): string {
  if (ms < 60_000) return '—'
  return (count / (ms / HOUR_MS)).toLocaleString('fr-FR', { maximumFractionDigits: 1 })
}

export function ProgressView({ snapshot }: ProgressViewProps) {
  const [copied, setCopied] = useState(false)
  if (!snapshot) {
    return <div className="progress-view progress-view-empty">Chargement de la progression…</div>
  }

  const report = [
    `Pupitre · ${formatDuration(snapshot.user.ms)} passées sur ${snapshot.projectCount} projet(s)`,
    `Cette semaine : ${formatDuration(snapshot.weekUserMs)} (agent ${formatDuration(snapshot.weekAgentMs)})`,
    `Supervision ${formatDuration(snapshot.supervisionMs)} · rédaction ${formatDuration(snapshot.writingMs)}`,
    ...snapshot.projects.map(
      (project) => `${project.name} : ${formatDuration(project.user.ms)} (agent ${formatDuration(project.agent.ms)})`,
    ),
  ].join('\n')

  async function copyReport() {
    try {
      await navigator.clipboard.writeText(report)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1_500)
    } catch {
      setCopied(false)
    }
  }

  const ringLen = 283
  // Le héros mesure la marche vers le palier suivant, pas l'heure en cours :
  // à l'échelle d'une vie de projet, une heure ne se voit pas.
  const reachedMilestone = [...snapshot.milestones].reverse().find((step) => step.reached)
  const floorMs = (reachedMilestone?.hours ?? 0) * HOUR_MS
  const ceilingMs = (snapshot.nextMilestone ?? snapshot.user.ms / HOUR_MS) * HOUR_MS
  const milestoneProgress = ceilingMs > floorMs
    ? Math.max(0, Math.min(1, (snapshot.user.ms - floorMs) / (ceilingMs - floorMs)))
    : 1
  const supervisionShare = snapshot.user.ms > 0
    ? Math.round((snapshot.supervisionMs / snapshot.user.ms) * 100)
    : 0
  const weekDelta = snapshot.weekUserMs - snapshot.previousWeekUserMs
  const widest = Math.max(1, ...snapshot.projects.map((project) => project.user.ms))
  const activeToday = snapshot.projects.filter((project) => project.user.todayMs > 0).length

  const stats: Array<{ label: string; value: string; trend: string; muted?: boolean }> = [
    {
      label: 'Heures (7 j)',
      value: formatDuration(snapshot.weekUserMs),
      trend: `${weekDelta >= 0 ? '+' : '−'}${formatDuration(Math.abs(weekDelta))} vs semaine passée`,
    },
    {
      label: 'Aujourd’hui',
      value: formatDuration(snapshot.user.todayMs),
      trend: `${activeToday} projet${activeToday > 1 ? 's' : ''} touché${activeToday > 1 ? 's' : ''}`,
    },
    {
      label: 'Moyenne / jour',
      value: formatDuration(snapshot.activeDays > 0 ? snapshot.user.ms / snapshot.activeDays : 0),
      trend: `sur ${snapshot.activeDays} jour${snapshot.activeDays > 1 ? 's' : ''} actif${snapshot.activeDays > 1 ? 's' : ''}`,
    },
    {
      label: 'Commits / h',
      value: ratePerHour(snapshot.commits, snapshot.user.ms),
      trend: `${snapshot.commits} commit${snapshot.commits > 1 ? 's' : ''} lié${snapshot.commits > 1 ? 's' : ''}`,
    },
    {
      label: 'Agent en parallèle',
      value: formatDuration(snapshot.agent.ms),
      trend: snapshot.user.ms > 0
        ? `${(snapshot.agent.ms / snapshot.user.ms).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} h par heure passée`
        : '—',
      muted: true,
    },
  ]

  const reachedCount = snapshot.milestones.filter((step) => step.reached).length

  return (
    <div className="progress-view">
      <div className="progress-container">
        <div className="progress-toolbar">
          <button type="button" className="secondary-button" onClick={() => void copyReport()}>
            {copied ? 'Copié' : 'Copier le rapport'}
          </button>
        </div>

        <div className="progress-hero">
          <div className="progress-ring" aria-hidden="true">
            <svg width="104" height="104" viewBox="0 0 104 104">
              <circle cx="52" cy="52" r="45" fill="none" stroke="var(--border-subtle)" strokeWidth="7" />
              <circle
                cx="52"
                cy="52"
                r="45"
                fill="none"
                stroke="var(--accent)"
                strokeWidth="7"
                strokeLinecap="round"
                strokeDasharray={ringLen}
                strokeDashoffset={ringLen * (1 - milestoneProgress)}
                transform="rotate(-90 52 52)"
                className="progress-ring-fill"
              />
            </svg>
            <div className="progress-ring-label">
              <span>Heures</span>
              <strong>{snapshot.user.level}</strong>
            </div>
          </div>

          <div className="progress-hero-main">
            <h1>
              {formatDuration(snapshot.user.ms)} passées dans Pupitre, sur {snapshot.projectCount}
              {' '}projet{snapshot.projectCount > 1 ? 's' : ''}
            </h1>
            <p>
              {snapshot.nextMilestone !== null
                ? `Palier ${snapshot.nextMilestone} h dans ${formatDuration(snapshot.msToNextMilestone ?? 0)}`
                : 'Tous les paliers sont franchis'}
            </p>
            <div className="progress-xp-track" aria-label={`${Math.round(milestoneProgress * 100)} % du palier suivant`}>
              <span className="progress-xp-fill" style={{ width: `${milestoneProgress * 100}%` }} />
              <span className="progress-xp-sheen" />
            </div>
          </div>

          <div className="progress-focus-card">
            <div className="progress-focus-card-row">
              <span className="progress-focus-icon" aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="8" cy="8" r="6.2" />
                  <path d="M8 4.4V8l2.4 1.6" />
                </svg>
              </span>
              <div>
                <div className="progress-focus-value">{formatDuration(snapshot.user.todayMs)}</div>
                <div className="progress-focus-caption">aujourd’hui</div>
              </div>
            </div>
            <div className="progress-focus-sub">
              agent {formatDuration(snapshot.agent.todayMs)} en parallèle
            </div>
          </div>
        </div>

        {snapshot.backfilledMs > 0 ? (
          <p className="progress-backfill-note">
            Dont {formatDuration(snapshot.backfilledMs)} reconstituées depuis l’historique des tours et
            réparties entre les projets au prorata : ces heures-là n’ont pas d’horaire, donc le partage
            rédaction / supervision ne vaut que pour les heures mesurées directement.
          </p>
        ) : null}

        <div className="progress-stat-grid">
          {stats.map((stat) => (
            <div className="progress-stat-tile" key={stat.label} data-muted={stat.muted === true}>
              <div className="progress-stat-label">{stat.label}</div>
              <div className="progress-stat-value">{stat.value}</div>
              <div className="progress-stat-trend">{stat.trend}</div>
            </div>
          ))}
        </div>

        <div className="progress-two-col">
          <div>
            <div className="progress-col-heading">
              <h2>Heures par projet</h2>
              <span>
                {snapshot.projectCount} projet{snapshot.projectCount > 1 ? 's' : ''}
                {' · '}
                {formatDuration(snapshot.user.ms)}
              </span>
            </div>
            <div className="progress-goals">
              {snapshot.projects.map((project) => (
                <div className="progress-goal-card" key={project.projectId}>
                  <div className="progress-goal-top">
                    <span>{project.name}</span>
                    <span className="progress-goal-value">{formatDuration(project.user.ms)}</span>
                  </div>
                  <div className="progress-goal-track">
                    <span style={{ width: `${(project.user.ms / widest) * 100}%` }} />
                  </div>
                  <div className="progress-goal-hint">
                    <span>
                      {project.nextMilestone !== null
                        ? `palier ${project.nextMilestone} h dans ${formatDuration(project.msToNextMilestone ?? 0)}`
                        : 'tous les paliers franchis'}
                    </span>
                    <span className="progress-goal-agent">agent {formatDuration(project.agent.ms)}</span>
                  </div>
                </div>
              ))}
              {snapshot.projects.length === 0 ? (
                <p className="progress-goal-hint">Aucune heure mesurée pour l’instant.</p>
              ) : null}
            </div>
          </div>

          <div>
            <div className="progress-col-heading">
              <h2>Paliers</h2>
              <span>{reachedCount} / {snapshot.milestones.length} franchis</span>
            </div>
            <div className="progress-complexity-rows">
              {snapshot.milestones.map((step) => {
                const isNext = step.hours === snapshot.nextMilestone
                return (
                  <div
                    className="progress-milestone-row"
                    key={step.hours}
                    data-reached={step.reached}
                    data-next={isNext}
                  >
                    <span className="progress-milestone-chip">{step.hours} h</span>
                    <div className="progress-complexity-mid">
                      <div className="progress-complexity-mid-top">
                        <span>{step.hours} heures passées</span>
                        <span>
                          {step.reached
                            ? `franchi le ${formatDate(step.reachedOn)}`
                            : isNext
                              ? `dans ${formatDuration(snapshot.msToNextMilestone ?? 0)}`
                              : 'verrouillé'}
                        </span>
                      </div>
                      {isNext ? (
                        <div className="progress-complexity-track">
                          <span style={{ width: `${milestoneProgress * 100}%` }} />
                        </div>
                      ) : null}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        <div className="progress-badges-section">
          <div className="progress-col-heading">
            <h2>Les deux natures de tes heures</h2>
            <span>{formatDuration(snapshot.user.ms)} au total</span>
          </div>
          <div className="progress-split">
            <div className="progress-split-track" aria-hidden="true">
              <span
                className="progress-split-writing"
                style={{ width: `${snapshot.user.ms > 0 ? (snapshot.writingMs / snapshot.user.ms) * 100 : 0}%` }}
              />
              <span
                className="progress-split-supervision"
                style={{ width: `${snapshot.user.ms > 0 ? (snapshot.supervisionMs / snapshot.user.ms) * 100 : 0}%` }}
              />
            </div>
            <div className="progress-split-legend">
              <span>
                <i className="is-writing" aria-hidden="true" />
                Rédaction {formatDuration(snapshot.writingMs)} — tu travailles, rien ne tourne
              </span>
              <span>
                <i className="is-supervision" aria-hidden="true" />
                Supervision {formatDuration(snapshot.supervisionMs)} — {supervisionShare} % de tes heures
              </span>
              <span className="progress-split-alone">
                Agent sans toi {formatDuration(snapshot.agentAloneMs)} — ne compte pas dans le niveau
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
