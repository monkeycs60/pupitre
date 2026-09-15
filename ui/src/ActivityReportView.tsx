import { useEffect, useMemo, useState } from 'react'
import { createActivityMotifTask, dismissActivityMotif, getActivityReport, getActivityReportIndex, runActivityReport, type ActivityReport, type ActivityReportIndex } from './api'

const hours = (ms: number) => ms < 60_000 ? '0 h' : `${(ms / 3_600_000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} h`
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
    <header className="activity-report-header">
      <div><h1>Rapport d’activité</h1><p>{report ? dayLabel(report.day) : 'Aucune journée traitée'}</p></div>
      <button type="button" className="primary-button" disabled={busy || index.run.running} onClick={() => void run()}>{busy || index.run.running ? 'Passe en cours…' : 'Relancer aujourd’hui'}</button>
    </header>
    {error ? <p className="modal-error" role="alert">{error}</p> : null}
    <nav className="activity-days" aria-label="Jours du rapport">
      {index.days.map((item) => <button type="button" key={item.day} className={item.day === selectedDay ? 'is-active' : ''} onClick={() => void select(item.day)}><strong>{dayLabel(item.day)}</strong><span>{hours(item.userMs)} · {item.commits} commit{item.commits > 1 ? 's' : ''}</span></button>)}
    </nav>
    {!report ? <div className="empty-state"><p>Aucune activité n’a encore produit de rapport.</p></div> : <>
      <div className="activity-totals" aria-label="Totaux du jour">
        <span><strong>{hours(report.totals.userMs)}</strong> présence</span><span><strong>{hours(report.totals.agentMs)}</strong> agent</span><span><strong>{report.totals.commits}</strong> commits</span><span><strong>+{report.totals.linesAdded} −{report.totals.linesRemoved}</strong> lignes</span>
      </div>
      <section className="activity-journal"><h2>Journal du jour</h2>{report.projects.map((project) => <article key={project.projectId}>
        <header><h3>{project.projectName}</h3><span>{hours(project.userMs)} présence · {hours(project.agentMs)} agent</span></header>
        {project.topics.map((topic) => <div className="activity-topic" key={`${project.projectId}-${topic.title}`}><strong>{topic.title}</strong><p>{topic.detail}</p><div>{topic.conversationIds.map((id) => <button type="button" className="link-button" key={id} onClick={() => onOpenConversation(project.projectId, id)}>Ouvrir la conversation</button>)}</div></div>)}
        {project.commits.length ? <div className="activity-commits">{project.commits.map((commit) => <div key={commit.sha}><code>{commit.sha.slice(0, 7)}</code><span>{commit.productMessage || commit.subject}</span><b>+{commit.linesAdded ?? 0} −{commit.linesRemoved ?? 0}</b>{commit.conversationId === null ? <em>hors conversation</em> : null}</div>)}</div> : null}
        {project.tickets.length ? <p className="activity-links">Tickets : {project.tickets.map((ticket) => ticket.externalUrl ? <a key={ticket.id} href={ticket.externalUrl} target="_blank" rel="noreferrer">{ticket.key}</a> : <span key={ticket.id}>{ticket.key}</span>)}</p> : null}
        {project.todosDone.length ? <p className="activity-links">Tâches terminées : {project.todosDone.map((todo) => <span key={todo.id}>{todo.title}</span>)}</p> : null}
      </article>)}</section>
      <section className="activity-retro"><h2>Recul</h2><div className="activity-cumulative"><p>Depuis {index.retro.cumulative.firstDay ? dayLabel(index.retro.cumulative.firstDay) : 'le début'} : <strong>{index.retro.cumulative.activeDays} jours actifs</strong>, {hours(index.retro.cumulative.userMs)} de présence, {index.retro.cumulative.commits} commits, +{index.retro.cumulative.linesAdded} −{index.retro.cumulative.linesRemoved} lignes.</p>{index.retro.trends.map((trend) => <p key={trend.days}><strong>{trend.days} derniers jours</strong> · {trend.activeDays} actifs · {hours(trend.userMs)} · {trend.commits} commits</p>)}</div>
        <div className="activity-motifs">{index.retro.motifs.map((motif) => <article key={motif.id} className={changed.has(motif.id) ? 'is-changed' : ''}><header><h3>{motif.title}</h3><span>{motif.kind === 'idea' ? 'Idée' : motif.status === 'handled' ? 'Pris en charge' : motif.status === 'stabilized' ? 'Stabilisé' : 'Ouvert'}</span></header><p>{motif.statement}</p><div className="activity-evidence">{motif.evidence.map((evidence) => evidence.kind === 'conversation' ? <button type="button" className="link-button" key={`${evidence.kind}-${evidence.ref}`} onClick={() => onOpenConversation(evidence.project_id, evidence.ref)}>{evidence.label}</button> : <span key={`${evidence.kind}-${evidence.ref}`}>{evidence.label}</span>)}</div>{motif.status === 'open' ? <footer><button type="button" className="primary-button" disabled={busy} onClick={() => void act(motif.id, 'task')}>Créer une tâche</button><button type="button" className="secondary-button" disabled={busy} onClick={() => void act(motif.id, 'dismiss')}>Écarter</button></footer> : null}</article>)}</div>
      </section>
    </>}
  </section>
}
