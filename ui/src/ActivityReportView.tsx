import { useEffect, useMemo, useState } from 'react'
import {
  createActivityMotifTask,
  dismissActivityMotif,
  getActivityReport,
  getActivityReportIndex,
  runActivityReport,
  type ActivityReport,
  type ActivityReportIndex,
  type ActivityReportProject,
  type ActivityReportTicket,
} from './api'
import { ActivityCalendar } from './ActivityCalendar'
import { ExternalLink } from './externalLink'

const hours = (ms: number) => ms < 60_000 ? '0 h' : `${(ms / 3_600_000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} h`
const number = (value: number) => value.toLocaleString('fr-FR')
const plural = (count: number, singular: string, pluralForm = `${singular}s`) => `${number(count)} ${count > 1 ? pluralForm : singular}`
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)
const dayLabel = (day: string) => capitalize(new Date(`${day}T12:00:00`).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }))
const shortDayLabel = (day: string) => capitalize(new Date(`${day}T12:00:00`).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' }))
const clock = (iso: string) => new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })

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

function Lines({ added, removed, muted = false }: { added: number; removed: number; muted?: boolean }) {
  return <span className={`activity-lines${muted ? ' is-muted' : ''}`}><i>+{number(added)}</i><em>−{number(removed)}</em></span>
}

function ProjectCard({ project, onOpenConversation }: { project: ActivityReportProject; onOpenConversation: (projectId: string, conversationId: string) => void }) {
  const ticketById = useMemo(() => new Map(project.tickets.map((ticket) => [ticket.id, ticket])), [project.tickets])
  const conversationById = useMemo(() => new Map(project.conversations.map((conversation) => [conversation.id, conversation])), [project.conversations])
  return (
    <article className="activity-project">
      <header className="activity-project-header">
        <h3>{project.projectName}</h3>
        <p>
          <span>{hours(project.userMs)} de présence</span>
          <span>{hours(project.agentMs)} d’agent</span>
          <span>{plural(project.commits.length, 'commit')}</span>
          <Lines added={project.linesAdded} removed={project.linesRemoved} />
        </p>
      </header>

      {project.tickets.length > 0 ? (
        <div className="activity-project-tickets">
          {project.tickets.map((ticket) => <TicketChip key={ticket.id} ticket={ticket} />)}
        </div>
      ) : null}

      {(project.mergeRequests.length > 0 || project.ticketsReady.length > 0) ? (
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

      {project.commits.length > 0 ? (
        <div className="activity-commits">
          <div className="activity-commits-heading">
            <h4>{plural(project.commits.length, 'commit')}</h4>
            <span>{project.unlinkedCommitCount > 0 ? `${project.unlinkedCommitCount} hors conversation` : 'tous reliés à une conversation'}</span>
          </div>
          {project.commits.map((commit) => (
            <div className={`activity-commit${commit.conversationId === null ? ' is-unlinked' : ''}${commit.isMerge ? ' is-merge' : ''}`} key={commit.sha}>
              <span className="activity-commit-time">{clock(commit.committedAt)}</span>
              <code>{commit.sha.slice(0, 7)}</code>
              <p>
                {commit.productMessage || commit.subject}
                {commit.isMerge ? <span className="activity-merge">fusion</span> : null}
                {commit.repositoryPath !== '.' ? <small>{commit.repositoryPath}</small> : null}
              </p>
              <Lines added={commit.linesAdded ?? 0} removed={commit.linesRemoved ?? 0} muted={commit.isMerge} />
              {commit.conversationId
                ? <button type="button" className="activity-read is-small" onClick={() => onOpenConversation(project.projectId, commit.conversationId!)}>Conversation</button>
                : <span className="activity-unlinked">hors conversation</span>}
            </div>
          ))}
        </div>
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

export function ActivityReportView({ onOpenConversation }: { onOpenConversation: (projectId: string, conversationId: string) => void }) {
  const [index, setIndex] = useState<ActivityReportIndex | null>(null)
  const [report, setReport] = useState<ActivityReport | null>(null)
  const [selectedDay, setSelectedDay] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const today = new Date().toLocaleDateString('en-CA')

  async function refresh(preferred?: string) {
    const next = await getActivityReportIndex()
    setIndex(next)
    const day = preferred ?? selectedDay ?? next.days[0]?.day ?? null
    setSelectedDay(day)
    setReport(day ? await getActivityReport(day) : null)
  }
  useEffect(() => { void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : 'Chargement impossible')) }, [])
  async function select(day: string) { setSelectedDay(day); setReport(await getActivityReport(day)) }
  async function run() {
    setBusy(true); setError(null)
    try { await runActivityReport(today); await refresh(today) } catch (cause) { setError(cause instanceof Error ? cause.message : 'Passe impossible') } finally { setBusy(false) }
  }
  async function act(id: string, action: 'dismiss' | 'task') {
    setBusy(true)
    try { action === 'dismiss' ? await dismissActivityMotif(id) : await createActivityMotifTask(id); await refresh(selectedDay ?? undefined) } finally { setBusy(false) }
  }
  const changed = useMemo(() => new Set(report ? [...report.retro.created, ...report.retro.updated, ...report.retro.returned] : []), [report])
  const fallbackSummary = useMemo(() => {
    if (!report) return ''
    const names = report.projects.map((project) => project.projectName)
    const projectsText = names.length === 1 ? `sur ${names[0]}` : `sur ${names.slice(0, -1).join(', ')} et ${names[names.length - 1]}`
    return `${hours(report.totals.userMs)} de présence ${projectsText}, ${plural(report.totals.commits, 'commit')}, ${plural(report.totals.conversations, 'conversation')}.`
  }, [report])
  if (!index) return <div className="empty-state"><p>{error ?? 'Chargement du rapport…'}</p></div>

  return (
    <section className="activity-report-view">
      <header className="activity-report-header">
        <h1>Rapport d’activité</h1>
        <button type="button" className="primary-button" disabled={busy || index.run.running} onClick={() => void run()}>
          {busy || index.run.running ? 'Passe en cours…' : 'Relancer aujourd’hui'}
        </button>
      </header>
      {error ? <p className="modal-error" role="alert">{error}</p> : null}

      <nav className="activity-days" aria-label="Jours du rapport">
        {index.days.map((item) => (
          <button type="button" key={item.day} className={item.day === selectedDay ? 'is-active' : ''} onClick={() => void select(item.day)}>
            <strong>{shortDayLabel(item.day)}</strong>
            <span>
              {plural(item.commits, 'commit')}
              {item.mergeRequests > 0 ? <b>{plural(item.mergeRequests, 'MR', 'MR')}</b> : null}
              {item.ticketsReady > 0 ? <b className="is-ready">{plural(item.ticketsReady, 'prêt')}</b> : null}
            </span>
          </button>
        ))}
      </nav>

      <ActivityCalendar calendar={index.calendar} selectedDay={selectedDay} onSelect={(day) => void select(day)} />

      {!report ? <div className="empty-state"><p>Aucune activité n’a encore produit de rapport.</p></div> : <>
        <section className="activity-day">
          <h2>{dayLabel(report.day)}</h2>
          <p className={`activity-summary${report.summary ? '' : ' is-fallback'}`}>{report.summary ?? fallbackSummary}</p>
          <dl className="activity-totals" aria-label="Totaux du jour">
            <div className={`is-outcome${report.totals.mergeRequests === 0 ? ' is-zero' : ''}`}><dd>{number(report.totals.mergeRequests)}</dd><dt>{report.totals.mergeRequests > 1 ? 'MR ouvertes' : 'MR ouverte'}</dt></div>
            <div className={`is-outcome is-ready${report.totals.ticketsReady === 0 ? ' is-zero' : ''}`}><dd>{number(report.totals.ticketsReady)}</dd><dt>{report.totals.ticketsReady > 1 ? 'tickets prêts pour la prod' : 'ticket prêt pour la prod'}</dt></div>
            <div><dd>{number(report.totals.commits)}</dd><dt>{report.totals.commits > 1 ? 'commits' : 'commit'}</dt></div>
            <div><dd><Lines added={report.totals.linesAdded} removed={report.totals.linesRemoved} /></dd><dt>lignes</dt></div>
            <div><dd>{hours(report.totals.userMs)}</dd><dt>de présence</dt></div>
            <div><dd>{hours(report.totals.agentMs)}</dd><dt>d’agent</dt></div>
          </dl>
        </section>

        <section className="activity-journal" aria-label="Journal par projet">
          {report.projects.map((project) => <ProjectCard key={project.projectId} project={project} onOpenConversation={onOpenConversation} />)}
        </section>

        <section className="activity-retro">
          <h2>Recul</h2>
          <div className="activity-cumulative">
            <p>Depuis {index.retro.cumulative.firstDay ? dayLabel(index.retro.cumulative.firstDay) : 'le début'} : <strong>{plural(index.retro.cumulative.activeDays, 'jour actif', 'jours actifs')}</strong>, {hours(index.retro.cumulative.userMs)} de présence, {plural(index.retro.cumulative.commits, 'commit')}, <Lines added={index.retro.cumulative.linesAdded} removed={index.retro.cumulative.linesRemoved} /> lignes.</p>
            {index.retro.trends.map((trend) => <p key={trend.days}><strong>{trend.days} derniers jours</strong> : {plural(trend.activeDays, 'jour actif', 'jours actifs')}, {hours(trend.userMs)}, {plural(trend.commits, 'commit')}</p>)}
          </div>
          <div className="activity-motifs">
            {index.retro.motifs.map((motif) => (
              <article key={motif.id} className={changed.has(motif.id) ? 'is-changed' : ''}>
                <header>
                  <h3>{motif.title}</h3>
                  <span>{motif.kind === 'idea' ? 'Idée' : motif.status === 'handled' ? 'Pris en charge' : motif.status === 'stabilized' ? 'Stabilisé' : 'Ouvert'}</span>
                </header>
                <p>{motif.statement}</p>
                <div className="activity-evidence">
                  {motif.evidence.map((evidence) => evidence.kind === 'conversation'
                    ? <button type="button" className="activity-read is-small" key={`${evidence.kind}-${evidence.ref}`} onClick={() => onOpenConversation(evidence.project_id, evidence.ref)}>{evidence.label}</button>
                    : <span key={`${evidence.kind}-${evidence.ref}`}>{evidence.label}</span>)}
                </div>
                {motif.status === 'open' ? (
                  <footer>
                    <button type="button" className="primary-button" disabled={busy} onClick={() => void act(motif.id, 'task')}>Créer une tâche</button>
                    <button type="button" className="secondary-button" disabled={busy} onClick={() => void act(motif.id, 'dismiss')}>Écarter</button>
                  </footer>
                ) : null}
              </article>
            ))}
          </div>
        </section>
      </>}
    </section>
  )
}
