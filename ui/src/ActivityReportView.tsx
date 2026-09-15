import { useEffect, useMemo, useState } from 'react'
import { createActivityMotifTask, dismissActivityMotif, getActivityReport, getActivityReportIndex, runActivityReport, type ActivityReport, type ActivityReportIndex } from './api'

const hours = (ms: number) => ms < 60_000 ? '0 h' : `${(ms / 3_600_000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} h`
const number = (value: number) => value.toLocaleString('fr-FR')
const dayLabel = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })

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
  if (!index) return <div className="empty-state"><p>{error ?? 'Chargement du rapport…'}</p></div>

  return <section className="activity-report-view">
    <header className="activity-report-header"><div><h1>Rapport d’activité</h1><p>{report ? dayLabel(report.day) : 'Aucune journée traitée'}</p></div><button type="button" className="primary-button" disabled={busy || index.run.running} onClick={() => void run()}>{busy || index.run.running ? 'Passe en cours…' : 'Relancer aujourd’hui'}</button></header>
    {error ? <p className="modal-error" role="alert">{error}</p> : null}
    <nav className="activity-days" aria-label="Jours du rapport">{index.days.map((item) => <button type="button" key={item.day} className={item.day === selectedDay ? 'is-active' : ''} onClick={() => void select(item.day)}><strong>{dayLabel(item.day)}</strong><span>{hours(item.userMs)} · {item.commits} commit{item.commits > 1 ? 's' : ''}</span></button>)}</nav>

    {!report ? <div className="empty-state"><p>Aucune activité n’a encore produit de rapport.</p></div> : <>
      <div className="activity-totals" aria-label="Totaux du jour">
        <div><strong>{hours(report.totals.userMs)}</strong><span>Présence</span></div><div><strong>{hours(report.totals.agentMs)}</strong><span>Temps agent</span></div><div><strong>{number(report.totals.commits)}</strong><span>Commits</span></div><div className="activity-lines-total"><strong><i>+{number(report.totals.linesAdded)}</i> <em>−{number(report.totals.linesRemoved)}</em></strong><span>Lignes modifiées</span></div>
      </div>

      <section className="activity-journal"><h2>Journal du jour</h2>{report.projects.map((project) => <article className="activity-project" key={project.projectId}>
        <header className="activity-project-header"><div><h3>{project.projectName}</h3><p>{project.topics.length} sujet{project.topics.length > 1 ? 's' : ''} traité{project.topics.length > 1 ? 's' : ''}</p></div><dl><div><dt>Présence</dt><dd>{hours(project.userMs)}</dd></div><div><dt>Agent</dt><dd>{hours(project.agentMs)}</dd></div><div><dt>Commits</dt><dd>{project.commits.length}</dd></div><div><dt>Lignes</dt><dd><span>+{number(project.linesAdded)}</span> <em>−{number(project.linesRemoved)}</em></dd></div></dl></header>

        {project.tickets.length > 0 ? <div className="activity-project-tickets"><span>Tickets</span><div>{project.tickets.map((ticket) => ticket.externalUrl ? <a key={ticket.id} href={ticket.externalUrl} target="_blank" rel="noreferrer"><strong>{ticket.key}</strong>{ticket.title}</a> : <span key={ticket.id}><strong>{ticket.key}</strong>{ticket.title}</span>)}</div></div> : null}

        <div className="activity-topics">{project.topics.map((topic) => {
          const conversations = project.conversations.filter((conversation) => topic.conversationIds.includes(conversation.id))
          const ticketIds = new Set(conversations.map((conversation) => conversation.ticketId).filter(Boolean))
          const tickets = project.tickets.filter((ticket) => ticketIds.has(ticket.id))
          return <section className="activity-topic" key={`${project.projectId}-${topic.title}`}><div className="activity-topic-heading"><h4>{topic.title}</h4>{tickets.map((ticket) => <span key={ticket.id}>{ticket.key} · {ticket.title}</span>)}</div><p>{topic.detail}</p><div className="activity-topic-actions">{topic.conversationIds.map((id, position) => <button type="button" className="link-button" key={id} onClick={() => onOpenConversation(project.projectId, id)}>Conversation{topic.conversationIds.length > 1 ? ` ${position + 1}` : ''}</button>)}</div></section>
        })}</div>

        {project.commits.length > 0 ? <div className="activity-commits"><div className="activity-commits-heading"><h4>{project.commits.length} commit{project.commits.length > 1 ? 's' : ''}</h4><span>{project.unlinkedCommitCount > 0 ? `${project.unlinkedCommitCount} hors conversation` : 'Tous reliés à une conversation'}</span></div>{project.commits.map((commit) => <div className="activity-commit" key={commit.sha}><div><code>{commit.sha.slice(0, 7)}</code>{commit.repositoryPath !== '.' ? <span>{commit.repositoryPath}</span> : null}</div><p>{commit.productMessage || commit.subject}</p><b><i>+{number(commit.linesAdded ?? 0)}</i><em>−{number(commit.linesRemoved ?? 0)}</em></b>{commit.conversationId === null ? <span className="activity-unlinked">hors conversation</span> : null}</div>)}</div> : null}
        {project.todosDone.length > 0 ? <div className="activity-done"><span>Tâches terminées</span>{project.todosDone.map((todo) => <strong key={todo.id}>{todo.title}</strong>)}</div> : null}
      </article>)}</section>

      <section className="activity-retro"><h2>Recul</h2><div className="activity-cumulative"><p>Depuis {index.retro.cumulative.firstDay ? dayLabel(index.retro.cumulative.firstDay) : 'le début'} : <strong>{index.retro.cumulative.activeDays} jours actifs</strong>, {hours(index.retro.cumulative.userMs)} de présence, {index.retro.cumulative.commits} commits, +{index.retro.cumulative.linesAdded} −{index.retro.cumulative.linesRemoved} lignes.</p>{index.retro.trends.map((trend) => <p key={trend.days}><strong>{trend.days} derniers jours</strong> · {trend.activeDays} actifs · {hours(trend.userMs)} · {trend.commits} commits</p>)}</div><div className="activity-motifs">{index.retro.motifs.map((motif) => <article key={motif.id} className={changed.has(motif.id) ? 'is-changed' : ''}><header><h3>{motif.title}</h3><span>{motif.kind === 'idea' ? 'Idée' : motif.status === 'handled' ? 'Pris en charge' : motif.status === 'stabilized' ? 'Stabilisé' : 'Ouvert'}</span></header><p>{motif.statement}</p><div className="activity-evidence">{motif.evidence.map((evidence) => evidence.kind === 'conversation' ? <button type="button" className="link-button" key={`${evidence.kind}-${evidence.ref}`} onClick={() => onOpenConversation(evidence.project_id, evidence.ref)}>{evidence.label}</button> : <span key={`${evidence.kind}-${evidence.ref}`}>{evidence.label}</span>)}</div>{motif.status === 'open' ? <footer><button type="button" className="primary-button" disabled={busy} onClick={() => void act(motif.id, 'task')}>Créer une tâche</button><button type="button" className="secondary-button" disabled={busy} onClick={() => void act(motif.id, 'dismiss')}>Écarter</button></footer> : null}</article>)}</div></section>
    </>}
  </section>
}
