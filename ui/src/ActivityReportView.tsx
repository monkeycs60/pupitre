import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import {
  createActivityMotifTask,
  dismissActivityMotif,
  getActivityReport,
  getActivityReportIndex,
  runActivityReport,
  runActivityTriage,
  type ActivityMotif,
  type ActivityReport,
  type ActivityReportIndex,
  type ActivityReportProject,
  type ActivityReportTicket,
} from './api'
import { ActivityAgenda, addDays, duration, localDay } from './ActivityAgenda'
import { ExternalLink } from './externalLink'

export type ReportTab = 'agenda' | 'journal' | 'recul'

/** Motifs affichés par projet ; au-delà, la réserve. */
export const TOP_MOTIFS = 10
/** Fenêtre pendant laquelle une hausse d'étoiles reste signalée. */
export const RISING_DAYS = 7
const RISING_MAX = 5

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)
const dayLabel = (day: string) => capitalize(new Date(`${day}T12:00:00`).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }))
const shortDay = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })
const clock = (iso: string) => new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
const plural = (count: number, singular: string, pluralForm = `${singular}s`) => `${count.toLocaleString('fr-FR')} ${count > 1 ? pluralForm : singular}`
const KIND_LABEL: Record<ActivityMotif['kind'], string> = { recurrence: 'récurrence', stabilize: 'à stabiliser', practice: 'pratique', idea: 'idée' }

/** Ouverts uniquement : le top dans l'ordre du tri, la réserve ensuite ; sans tri, la fraîcheur décide. */
export function rankMotifs(motifs: ActivityMotif[]): { top: ActivityMotif[]; reserve: ActivityMotif[]; triaged: boolean } {
  const open = motifs.filter((motif) => motif.status === 'open')
  const ranked = open.filter((motif) => motif.rank !== null).sort((left, right) => left.rank! - right.rank!)
  if (ranked.length === 0) {
    const fresh = [...open].sort((left, right) => right.last_seen_day.localeCompare(left.last_seen_day))
    return { top: fresh.slice(0, TOP_MOTIFS), reserve: fresh.slice(TOP_MOTIFS), triaged: false }
  }
  const top = ranked.slice(0, TOP_MOTIFS)
  const shown = new Set(top.map((motif) => motif.id))
  const reserve = open.filter((motif) => !shown.has(motif.id))
    .sort((left, right) => (right.stars ?? 0) - (left.stars ?? 0) || right.last_seen_day.localeCompare(left.last_seen_day))
  return { top, reserve, triaged: true }
}

/** Motifs ouverts dont la note a monté au tri des derniers jours : la friction qui s'aggrave. */
export function risingMotifs(motifs: ActivityMotif[], today: string): ActivityMotif[] {
  const since = addDays(today, -RISING_DAYS)
  return motifs
    .filter((motif) => motif.status === 'open' && motif.stars !== null && motif.stars_previous !== null && motif.stars > motif.stars_previous && (motif.stars_changed_day ?? '') >= since)
    .sort((left, right) => (right.stars! - right.stars_previous!) - (left.stars! - left.stars_previous!) || right.stars! - left.stars!)
    .slice(0, RISING_MAX)
}

function ClickUpMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#ff02f0" d="M2.4 8.3 12.1 0l9.5 8.3-3.1 3.5-6.5-5.7-6.6 5.7Z" />
      <path fill="#7b68ee" d="m2 18.4 3.7-2.8c2 2.6 4 3.8 6.4 3.8 2.3 0 4.3-1.2 6.2-3.7l3.7 2.7c-2.7 3.7-6.1 5.6-10 5.6-3.8 0-7.2-1.9-10-5.6Z" />
    </svg>
  )
}

function GitLabMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#e24329" d="m12 21.4-3.5-10.7h7Z" />
      <path fill="#fc6d26" d="M12 21.4 8.5 10.7H3.6Zm0 0 3.5-10.7h4.9Z" />
      <path fill="#fca326" d="M3.6 10.7 2.5 14a.8.8 0 0 0 .3.9l9.2 6.6Zm16.8 0 1.1 3.3a.8.8 0 0 1-.3.9L12 21.4Z" />
      <path fill="#e24329" d="M3.6 10.7h4.9L6.4 4.2a.4.4 0 0 0-.7 0Zm16.8 0h-4.9l2.1-6.5a.4.4 0 0 1 .7 0Z" />
    </svg>
  )
}

/** Clé + titre, cliquable vers ClickUp quand l'URL est connue. */
function TicketChip({ ticket, compact = false }: { ticket: ActivityReportTicket; compact?: boolean }) {
  const body = <><strong>{ticket.key}</strong>{compact ? null : <span>{ticket.title}</span>}</>
  if (!ticket.externalUrl) return <span className="activity-ticket">{body}</span>
  return (
    <ExternalLink className="activity-ticket is-link" href={ticket.externalUrl} title={`Ouvrir ${ticket.key} dans ClickUp`} ariaLabel={`Ouvrir ${ticket.key} dans ClickUp`}>
      <ClickUpMark />{body}
    </ExternalLink>
  )
}

function ProjectJournal({ project, onOpenConversation }: { project: ActivityReportProject; onOpenConversation: (projectId: string, conversationId: string) => void }) {
  const ticketById = useMemo(() => new Map(project.tickets.map((ticket) => [ticket.id, ticket])), [project.tickets])
  const conversationById = useMemo(() => new Map(project.conversations.map((conversation) => [conversation.id, conversation])), [project.conversations])
  const outcomes = project.mergeRequests.length + project.ticketsReady.length
  return (
    <article className="activity-project">
      <header className="activity-project-header">
        <h3>{project.projectName}</h3>
        <p><span>{duration(project.userMs)} de présence</span><span>{duration(project.agentMs)} d’agent</span></p>
      </header>

      {outcomes > 0 ? (
        <div className="activity-outcomes">
          {project.mergeRequests.map((mr) => (
            <ExternalLink key={mr.ref} className="activity-outcome is-mr" href={mr.url} title={`Ouvrir ${mr.ref} dans GitLab`} ariaLabel={`Ouvrir ${mr.ref} dans GitLab`}>
              <GitLabMark />
              <span className="activity-outcome-kind">MR ouverte</span>
              <span className="activity-outcome-title">{mr.title}</span>
              <span className="activity-outcome-meta">{mr.project} !{mr.iid}{mr.state === 'merged' ? ', fusionnée' : ''}</span>
            </ExternalLink>
          ))}
          {project.ticketsReady.map((ticket) => {
            const body = <>
              <span className="activity-outcome-kind">Prêt pour la prod</span>
              <span className="activity-outcome-title"><strong>{ticket.key}</strong> {ticket.title}</span>
              <span className="activity-outcome-meta">{clock(ticket.changedAt)}</span>
            </>
            return ticket.externalUrl
              ? <ExternalLink key={ticket.ticketId} className="activity-outcome is-ready" href={ticket.externalUrl} title={`Ouvrir ${ticket.key} dans ClickUp`} ariaLabel={`Ouvrir ${ticket.key} dans ClickUp`}><ClickUpMark />{body}</ExternalLink>
              : <span key={ticket.ticketId} className="activity-outcome is-ready">{body}</span>
          })}
        </div>
      ) : null}

      {project.topics.length > 0 ? (
        <ol className="activity-topics">
          {project.topics.map((topic) => {
            const ticketIds = new Set(topic.conversationIds.map((id) => conversationById.get(id)?.ticketId).filter(Boolean))
            const tickets = [...ticketIds].map((id) => ticketById.get(id!)).filter((ticket): ticket is ActivityReportTicket => ticket !== undefined)
            return (
              <li className="activity-topic" key={`${project.projectId}-${topic.title}`}>
                <div className="activity-topic-body">
                  <h4>{topic.title}</h4>
                  <p>{topic.detail}</p>
                </div>
                <div className="activity-topic-side">
                  {tickets.map((ticket) => <TicketChip key={ticket.id} ticket={ticket} compact />)}
                  {topic.conversationIds.map((id, position) => {
                    const conversation = conversationById.get(id)
                    const label = topic.conversationIds.length > 1 ? `Lire la conversation ${position + 1}` : 'Lire la conversation'
                    return (
                      <button type="button" className="activity-read" key={id} title={conversation?.title} data-conversation-id={id} onClick={() => onOpenConversation(project.projectId, id)}>
                        {label}
                        {conversation && conversation.turns > 0 ? <span>{plural(conversation.turns, 'tour')}</span> : null}
                      </button>
                    )
                  })}
                </div>
              </li>
            )
          })}
        </ol>
      ) : null}

      {project.todosDone.length > 0 ? (
        <div className="activity-done">
          <span>Tâches terminées</span>
          {project.todosDone.map((todo) => <strong key={todo.id}>{todo.title}</strong>)}
        </div>
      ) : null}
    </article>
  )
}

function Journal({ index, day, report, onDay, onOpenConversation }: {
  index: ActivityReportIndex
  day: string
  report: ActivityReport | null
  onDay: (day: string) => void
  onOpenConversation: (projectId: string, conversationId: string) => void
}) {
  const days = index.days.map((item) => item.day)
  const older = days.find((item) => item < day) ?? null
  const newer = [...days].reverse().find((item) => item > day) ?? null
  const projects = report?.projects.filter((project) => project.topics.length > 0 || project.mergeRequests.length > 0 || project.ticketsReady.length > 0 || project.todosDone.length > 0) ?? []
  const meta = report ? [
    `${duration(report.totals.userMs)} de présence`,
    `${duration(report.totals.agentMs)} d’agent`,
    plural(report.totals.conversations, 'conversation'),
    report.totals.mergeRequests > 0 ? plural(report.totals.mergeRequests, 'MR ouverte', 'MR ouvertes') : null,
    report.totals.ticketsReady > 0 ? plural(report.totals.ticketsReady, 'ticket prêt pour la prod', 'tickets prêts pour la prod') : null,
  ].filter(Boolean).join(' · ') : ''
  return (
    <section className="activity-journal-tab">
      <div className="agenda-toolbar">
        <div className="agenda-nav">
          <button type="button" aria-label="Rapport précédent" disabled={!older} onClick={() => older && onDay(older)}>‹</button>
          <button type="button" className="agenda-today" disabled={!days[0]} onClick={() => days[0] && onDay(days[0])}>Dernier</button>
          <button type="button" aria-label="Rapport suivant" disabled={!newer} onClick={() => newer && onDay(newer)}>›</button>
        </div>
        <h2 className="agenda-period">{dayLabel(day)}</h2>
      </div>
      {!report ? <div className="empty-state"><p>Aucun rapport pour ce jour.</p></div> : <>
        <p className={`activity-summary${report.summary ? '' : ' is-fallback'}`}>{report.summary ?? 'Résumé indisponible pour ce jour.'}</p>
        <p className="activity-meta">{meta}</p>
        <div className="activity-journal">
          {projects.map((project) => <ProjectJournal key={project.projectId} project={project} onOpenConversation={onOpenConversation} />)}
        </div>
      </>}
    </section>
  )
}

function Stars({ count }: { count: number | null }) {
  if (count === null) return null
  return <span className="motif-stars" aria-label={`${count} étoile${count > 1 ? 's' : ''} sur 5`}>{'★'.repeat(count)}<i>{'★'.repeat(5 - count)}</i></span>
}

function MotifItem({ motif, position, projectName, busy, onAct, onOpenConversation }: {
  motif: ActivityMotif
  position: number | null
  projectName?: string
  busy: boolean
  onAct: (id: string, action: 'dismiss' | 'task') => void
  onOpenConversation: (projectId: string, conversationId: string) => void
}) {
  const rise = motif.stars !== null && motif.stars_previous !== null && motif.stars > motif.stars_previous
  return (
    <li className="motif" data-motif-id={motif.id}>
      {position !== null ? <span className="motif-rank">{position}</span> : null}
      <details>
        <summary>
          <span className="motif-title">{motif.title}</span>
          <span className="motif-kind">{projectName ? `${projectName} · ` : ''}{KIND_LABEL[motif.kind]}{motif.returned_at ? ' · revenu' : ''}</span>
          {motif.rank_reason ? <span className="motif-reason">{motif.rank_reason}</span> : null}
        </summary>
        <p>{motif.statement}</p>
        <div className="activity-evidence">
          {motif.evidence.map((evidence) => evidence.kind === 'conversation'
            ? <button type="button" className="activity-read is-small" key={`${evidence.kind}-${evidence.ref}`} onClick={() => onOpenConversation(evidence.project_id, evidence.ref)}>{evidence.label}</button>
            : <span key={`${evidence.kind}-${evidence.ref}`}>{evidence.label}</span>)}
        </div>
        <footer>
          <button type="button" className="primary-button" disabled={busy} onClick={() => onAct(motif.id, 'task')}>Créer une tâche</button>
          <button type="button" className="secondary-button" disabled={busy} onClick={() => onAct(motif.id, 'dismiss')}>Écarter</button>
        </footer>
      </details>
      <span className="motif-score">
        <Stars count={motif.stars} />
        {rise ? <small className="motif-rise">+{motif.stars! - motif.stars_previous!} le {shortDay(motif.stars_changed_day!)}</small> : null}
      </span>
    </li>
  )
}

function Recul({ retro, busy, onAct, onTriage, onOpenConversation }: {
  retro: ActivityReportIndex['retro']
  busy: boolean
  onAct: (id: string, action: 'dismiss' | 'task') => void
  onTriage: () => void
  onOpenConversation: (projectId: string, conversationId: string) => void
}) {
  const names = useMemo(() => new Map(retro.projects.map((project) => [project.id, project.name])), [retro.projects])
  const colors = useMemo(() => new Map(retro.projects.map((project) => [project.id, project.color])), [retro.projects])
  const byProject = useMemo(() => {
    const out = new Map<string, ActivityMotif[]>()
    for (const motif of retro.motifs) if (motif.status === 'open') out.set(motif.project_id, [...(out.get(motif.project_id) ?? []), motif])
    return [...out.entries()].sort((left, right) => right[1].length - left[1].length)
  }, [retro.motifs])
  const [selected, setSelected] = useState<string | null>(null)
  const current = byProject.find(([id]) => id === selected) ?? byProject[0]
  const rising = risingMotifs(retro.motifs, localDay(new Date()))
  if (!current) return <div className="empty-state"><p>Aucun constat ouvert. La passe du soir en relèvera dès qu’une friction revient.</p></div>
  const ranking = rankMotifs(current[1])
  const itemProps = { busy, onAct, onOpenConversation }
  return (
    <section className="recul">
      {rising.length > 0 ? (
        <div className="recul-rising">
          <h2>En hausse</h2>
          <p>Ces constats ont gagné des étoiles au dernier tri : la friction s’aggrave.</p>
          <ol className="motifs">
            {rising.map((motif) => <MotifItem key={motif.id} motif={motif} position={null} projectName={names.get(motif.project_id)} {...itemProps} />)}
          </ol>
        </div>
      ) : null}
      <div className="recul-head">
        <div className="recul-chips" role="tablist" aria-label="Projets">
          {byProject.map(([id, motifs]) => (
            <button type="button" role="tab" aria-selected={id === current[0]} key={id} className={id === current[0] ? 'is-active' : ''} style={{ '--project': colors.get(id) ?? '#94a3b8' } as CSSProperties} onClick={() => setSelected(id)}>
              <i />{names.get(id) ?? id}<small>{Math.min(TOP_MOTIFS, motifs.length)}</small>
            </button>
          ))}
        </div>
        <button type="button" className="secondary-button" disabled={busy} onClick={onTriage}>{busy ? 'Tri en cours…' : 'Retrier'}</button>
      </div>
      {!ranking.triaged ? <p className="recul-note">Pas encore trié : les plus récents d’abord. Le tri du soir les notera sur cinq étoiles.</p> : null}
      <ol className="motifs">
        {ranking.top.map((motif, position) => <MotifItem key={motif.id} motif={motif} position={position + 1} {...itemProps} />)}
      </ol>
      {ranking.reserve.length > 0 ? (
        <details className="recul-reserve">
          <summary>{plural(ranking.reserve.length, 'autre constat', 'autres constats')} en réserve</summary>
          <ol className="motifs">
            {ranking.reserve.map((motif) => <MotifItem key={motif.id} motif={motif} position={null} {...itemProps} />)}
          </ol>
        </details>
      ) : null}
    </section>
  )
}

export function ActivityReportView({ onOpenConversation }: { onOpenConversation: (projectId: string, conversationId: string) => void }) {
  const [tab, setTab] = useState<ReportTab>('agenda')
  const [index, setIndex] = useState<ActivityReportIndex | null>(null)
  const [report, setReport] = useState<ActivityReport | null>(null)
  const [selectedDay, setSelectedDay] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const today = localDay(new Date())

  async function loadDay(day: string) {
    setSelectedDay(day)
    setReport(await getActivityReport(day).catch(() => null))
  }
  async function refresh(preferred?: string) {
    const next = await getActivityReportIndex()
    setIndex(next)
    const day = preferred ?? selectedDay ?? next.days[0]?.day ?? today
    await loadDay(day)
  }
  useEffect(() => { void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : 'Chargement impossible')) }, [])
  async function run() {
    setBusy(true); setError(null)
    try { await runActivityReport(today); await refresh(today) } catch (cause) { setError(cause instanceof Error ? cause.message : 'Passe impossible') } finally { setBusy(false) }
  }
  async function triage() {
    setBusy(true); setError(null)
    try {
      const result = await runActivityTriage()
      setIndex((current) => current ? { ...current, retro: result.retro } : current)
      if (result.errors.length > 0) setError(result.errors.join(' · '))
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Tri impossible') } finally { setBusy(false) }
  }
  async function act(id: string, action: 'dismiss' | 'task') {
    setBusy(true)
    try { action === 'dismiss' ? await dismissActivityMotif(id) : await createActivityMotifTask(id); await refresh(selectedDay ?? undefined) } finally { setBusy(false) }
  }
  if (!index) return <div className="empty-state"><p>{error ?? 'Chargement du rapport…'}</p></div>
  const rising = risingMotifs(index.retro.motifs, today).length

  return (
    <section className="activity-report-view">
      <header className="activity-report-header">
        <div className="report-tabs" role="tablist" aria-label="Rapport">
          {(['agenda', 'journal', 'recul'] as const).map((item) => (
            <button type="button" role="tab" key={item} aria-selected={tab === item} className={tab === item ? 'is-active' : ''} onClick={() => setTab(item)}>
              {item === 'agenda' ? 'Agenda' : item === 'journal' ? 'Journal' : 'Recul'}
              {item === 'recul' && rising > 0 ? <span className="report-tab-badge" title={`${rising} constat${rising > 1 ? 's' : ''} en hausse`}>▲ {rising}</span> : null}
            </button>
          ))}
        </div>
        {tab === 'journal' ? (
          <button type="button" className="secondary-button" disabled={busy || index.run.running} onClick={() => void run()}>
            {busy || index.run.running ? 'Passe en cours…' : 'Relancer aujourd’hui'}
          </button>
        ) : null}
      </header>
      {error ? <p className="modal-error" role="alert">{error}</p> : null}
      <div className="report-pane">
        {tab === 'agenda' ? <ActivityAgenda onOpenConversation={onOpenConversation} onOpenDay={(day) => { setTab('journal'); void loadDay(day) }} /> : null}
        {tab === 'journal' ? <Journal index={index} day={selectedDay ?? today} report={report} onDay={(day) => void loadDay(day)} onOpenConversation={onOpenConversation} /> : null}
        {tab === 'recul' ? <Recul retro={index.retro} busy={busy} onAct={(id, action) => void act(id, action)} onTriage={() => void triage()} onOpenConversation={onOpenConversation} /> : null}
      </div>
    </section>
  )
}
