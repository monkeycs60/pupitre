import { useMemo } from 'react'
import type { ActivityReportProject } from './api'

const HOUR_MS = 3_600_000
const DEFAULT_START_HOUR = 8
const DEFAULT_END_HOUR = 20

const clock = (iso: string) => new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
const minutes = (ms: number) => `${Math.max(1, Math.round(ms / 60_000))} min`

function dayStartMs(day: string): number {
  return new Date(`${day}T00:00:00`).getTime()
}

/** Fenêtre horaire couvrant au moins 8 h à 20 h, élargie à l'heure ronde autour de l'activité. */
export function timelineWindow(day: string, projects: ActivityReportProject[]): { startMs: number; endMs: number } {
  const base = dayStartMs(day)
  let first = base + DEFAULT_START_HOUR * HOUR_MS
  let last = base + DEFAULT_END_HOUR * HOUR_MS
  const consider = (iso: string | undefined) => {
    if (!iso) return
    const at = Date.parse(iso)
    if (!Number.isFinite(at)) return
    if (at < first) first = at
    if (at > last) last = at
  }
  for (const project of projects) {
    for (const span of project.timeline?.presence ?? []) { consider(span.from); consider(span.to) }
    for (const span of project.timeline?.agent ?? []) { consider(span.from); consider(span.to) }
    for (const turn of project.timeline?.turns ?? []) consider(turn)
    for (const commit of project.commits) consider(commit.committedAt)
    for (const mr of project.mergeRequests) consider(mr.createdAt)
    for (const ticket of project.ticketsReady) consider(ticket.changedAt)
  }
  const startMs = base + Math.floor((first - base) / HOUR_MS) * HOUR_MS
  const endMs = base + Math.ceil((last - base) / HOUR_MS) * HOUR_MS
  return { startMs, endMs: Math.max(endMs, startMs + HOUR_MS) }
}

/** Rayon d'un commit en pixels : le volume de lignes compte, sans écraser les petits. */
export function commitRadius(lines: number): number {
  return Math.round(Math.min(7, 2.5 + Math.log10(Math.max(1, lines)) * 1.2))
}

export function ActivityTimeline({ day, projects, onOpenConversation }: {
  day: string
  projects: ActivityReportProject[]
  onOpenConversation: (projectId: string, conversationId: string) => void
}) {
  const { startMs, endMs } = useMemo(() => timelineWindow(day, projects), [day, projects])
  const total = endMs - startMs
  const x = (iso: string) => `${((Math.min(Math.max(Date.parse(iso), startMs), endMs) - startMs) / total * 100).toFixed(3)}%`
  const width = (from: string, to: string) => `${(Math.max(0, Math.min(Date.parse(to), endMs) - Math.max(Date.parse(from), startMs)) / total * 100).toFixed(3)}%`
  const hours = useMemo(() => {
    const out: Array<{ at: number; label: string }> = []
    const base = dayStartMs(day)
    for (let at = startMs; at <= endMs; at += HOUR_MS) out.push({ at, label: `${Math.round((at - base) / HOUR_MS)} h` })
    return out
  }, [day, startMs, endMs])
  const hourStep = hours.length > 15 ? 2 : 1

  return (
    <div className="activity-timeline" role="figure" aria-label="Frise horaire du jour">
      <div className="activity-timeline-axis" aria-hidden="true">
        {hours.map((hour, index) => (
          <span key={hour.at} className={`activity-timeline-hour${index % hourStep === 0 ? '' : ' is-minor'}`} style={{ left: `${((hour.at - startMs) / total * 100).toFixed(3)}%` }}>
            {index % hourStep === 0 ? hour.label : ''}
          </span>
        ))}
      </div>
      {projects.map((project) => {
        const timeline = project.timeline ?? { presence: [], agent: [], turns: [] }
        return (
          <div className="activity-timeline-row" key={project.projectId}>
            <span className="activity-timeline-name">{project.projectName}</span>
            <div className="activity-lane">
              {hours.map((hour) => <i key={hour.at} className="activity-lane-grid" style={{ left: `${((hour.at - startMs) / total * 100).toFixed(3)}%` }} aria-hidden="true" />)}
              {timeline.presence.map((span) => (
                <span key={`p-${span.from}`} className="activity-lane-presence" style={{ left: x(span.from), width: width(span.from, span.to) }} title={`Présence de ${clock(span.from)} à ${clock(span.to)}, ${minutes(Date.parse(span.to) - Date.parse(span.from))}`} />
              ))}
              {timeline.agent.map((span) => (
                <span key={`a-${span.from}`} className="activity-lane-agent" style={{ left: x(span.from), width: width(span.from, span.to) }} title={`Agent au travail de ${clock(span.from)} à ${clock(span.to)}`} />
              ))}
              {timeline.turns.map((turn, index) => (
                <span key={`t-${turn}-${index}`} className="activity-lane-turn" style={{ left: x(turn) }} title={`Tour envoyé à ${clock(turn)}`} />
              ))}
              {project.commits.map((commit) => {
                const lines = (commit.linesAdded ?? 0) + (commit.linesRemoved ?? 0)
                const radius = commitRadius(lines)
                const label = `${clock(commit.committedAt)} · ${commit.subject} (+${commit.linesAdded ?? 0} −${commit.linesRemoved ?? 0})${commit.branch.startsWith('origin/') ? ', poussé' : ''}`
                const style = { left: x(commit.committedAt), width: radius * 2, height: radius * 2 }
                return commit.conversationId
                  ? <button type="button" key={commit.sha} className="activity-lane-commit" style={style} title={label} aria-label={label} onClick={() => onOpenConversation(project.projectId, commit.conversationId!)} />
                  : <span key={commit.sha} className="activity-lane-commit is-unlinked" style={style} title={label} />
              })}
              {project.mergeRequests.map((mr) => (
                <a key={mr.ref} className="activity-lane-mr" style={{ left: x(mr.createdAt) }} href={mr.url} target="_blank" rel="noreferrer" title={`${clock(mr.createdAt)} · MR ouverte : ${mr.title}`} aria-label={`MR ouverte à ${clock(mr.createdAt)} : ${mr.title}`} />
              ))}
              {project.ticketsReady.map((ticket) => (
                ticket.externalUrl
                  ? <a key={ticket.ticketId} className="activity-lane-ready" style={{ left: x(ticket.changedAt) }} href={ticket.externalUrl} target="_blank" rel="noreferrer" title={`${clock(ticket.changedAt)} · ${ticket.key} prêt pour la prod`} aria-label={`${ticket.key} prêt pour la prod à ${clock(ticket.changedAt)}`} />
                  : <span key={ticket.ticketId} className="activity-lane-ready" style={{ left: x(ticket.changedAt) }} title={`${clock(ticket.changedAt)} · ${ticket.key} prêt pour la prod`} />
              ))}
            </div>
          </div>
        )
      })}
      <div className="activity-timeline-legend" aria-hidden="true">
        <span><i className="activity-lane-presence" /> présence</span>
        <span><i className="activity-lane-agent" /> agent</span>
        <span><i className="activity-lane-turn" /> tour</span>
        <span><i className="activity-lane-commit" /> commit, taille selon les lignes</span>
        <span><i className="activity-lane-mr" /> MR ouverte</span>
        <span><i className="activity-lane-ready" /> prêt pour la prod</span>
      </div>
    </div>
  )
}
