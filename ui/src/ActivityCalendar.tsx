import { useEffect, useMemo, useRef, useState } from 'react'
import type { ActivityCalendarDay } from './api'

export type CalendarMetric = 'lines' | 'commits'

const WEEKDAYS = ['Lun', '', 'Mer', '', 'Ven', '', 'Dim']
const number = (value: number) => value.toLocaleString('fr-FR')
const hours = (ms: number) => ms < 60_000 ? null : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} h`
const dayLabel = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' })
const monthLabel = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString('fr-FR', { month: 'short' })

/** Chiffres d'un jour, réduits à un projet quand un filtre est posé ; la présence n'est connue que tous projets confondus. */
export function dayFigures(day: ActivityCalendarDay, projectId: string | null): { commits: number; linesAdded: number; linesRemoved: number; mergeRequests: number; userMs: number | null } {
  if (projectId === null) return { commits: day.commits, linesAdded: day.linesAdded, linesRemoved: day.linesRemoved, mergeRequests: day.mergeRequests, userMs: day.userMs }
  const project = day.projects.find((item) => item.projectId === projectId)
  return { commits: project?.commits ?? 0, linesAdded: project?.linesAdded ?? 0, linesRemoved: project?.linesRemoved ?? 0, mergeRequests: project?.mergeRequests ?? 0, userMs: null }
}

export function metricValue(day: ActivityCalendarDay, metric: CalendarMetric, projectId: string | null = null): number {
  const figures = dayFigures(day, projectId)
  return metric === 'lines' ? figures.linesAdded + figures.linesRemoved : figures.commits
}

/** Valeurs des jours actifs, triées : la référence du rang de chaque jour. */
export function activeValues(values: number[]): number[] {
  return values.filter((value) => value > 0).sort((left, right) => left - right)
}

/** Niveau 0 pour un jour vide, sinon 1 à 4 selon le rang du jour parmi les jours actifs : le plus faible à 1, le plus fort à 4. */
export function levelOf(value: number, sorted: number[]): number {
  if (value <= 0) return 0
  if (sorted.length < 2) return 4
  let below = 0
  while (below < sorted.length && sorted[below]! < value) below += 1
  return 1 + Math.min(3, Math.floor((below / (sorted.length - 1)) * 4))
}

export function dayTitle(day: ActivityCalendarDay, projectId: string | null = null): string {
  const figures = dayFigures(day, projectId)
  const parts = [`${number(figures.commits)} commit${figures.commits > 1 ? 's' : ''}`, `+${number(figures.linesAdded)} −${number(figures.linesRemoved)}`]
  if (figures.mergeRequests > 0) parts.push(`${figures.mergeRequests} MR ouverte${figures.mergeRequests > 1 ? 's' : ''}`)
  const presence = figures.userMs === null ? null : hours(figures.userMs)
  if (presence) parts.push(`${presence} de présence`)
  const projects = projectId === null ? day.projects.filter((project) => project.commits > 0).map((project) => `${project.projectName} ${project.commits}`).join(', ') : ''
  return `${dayLabel(day.day)} : ${parts.join(', ')}${projects ? ` (${projects})` : ''}${day.hasReport ? '. Ouvrir le rapport' : ''}`
}

/** Projets rencontrés sur la période, du plus actif au moins actif. */
export function projectsOf(days: ActivityCalendarDay[]): Array<{ projectId: string; projectName: string; commits: number }> {
  const totals = new Map<string, { projectId: string; projectName: string; commits: number }>()
  for (const day of days) {
    for (const project of day.projects) {
      const entry = totals.get(project.projectId) ?? { projectId: project.projectId, projectName: project.projectName, commits: 0 }
      entry.commits += project.commits
      totals.set(project.projectId, entry)
    }
  }
  return [...totals.values()].sort((left, right) => right.commits - left.commits)
}

/** Colonnes de sept jours du lundi au dimanche ; la première commence par des cases vides jusqu'au premier jour. */
export function weeksOf(days: ActivityCalendarDay[]): Array<Array<ActivityCalendarDay | null>> {
  if (days.length === 0) return []
  const weeks: Array<Array<ActivityCalendarDay | null>> = []
  const offset = (new Date(`${days[0]!.day}T12:00:00`).getDay() + 6) % 7
  let week: Array<ActivityCalendarDay | null> = Array.from({ length: offset }, () => null)
  for (const day of days) {
    week.push(day)
    if (week.length === 7) { weeks.push(week); week = [] }
  }
  if (week.length > 0) { while (week.length < 7) week.push(null); weeks.push(week) }
  return weeks
}

export function ActivityCalendar({ calendar, selectedDay, onSelect }: {
  calendar: { from: string; to: string; days: ActivityCalendarDay[] }
  selectedDay: string | null
  onSelect: (day: string) => void
}) {
  const [metric, setMetric] = useState<CalendarMetric>('lines')
  const [projectId, setProjectId] = useState<string | null>(null)
  const weeks = useMemo(() => weeksOf(calendar.days), [calendar.days])
  const projects = useMemo(() => projectsOf(calendar.days), [calendar.days])
  const sorted = useMemo(() => activeValues(calendar.days.map((day) => metricValue(day, metric, projectId))), [calendar.days, metric, projectId])
  const scrollerRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const scroller = scrollerRef.current
    if (scroller) scroller.scrollLeft = scroller.scrollWidth
  }, [calendar.days])
  const months = useMemo(() => {
    const out: Array<{ label: string; column: number }> = []
    weeks.forEach((week, column) => {
      const first = week.find((day) => day !== null)
      if (!first) return
      const label = monthLabel(first.day)
      if (out.length === 0 || out[out.length - 1]!.label !== label) {
        if (out.length === 0 || column - out[out.length - 1]!.column >= 2) out.push({ label, column })
      }
    })
    return out
  }, [weeks])
  const thisMonth = calendar.to.slice(0, 7)
  const monthTotals = useMemo(() => calendar.days
    .filter((day) => day.day.startsWith(thisMonth))
    .map((day) => dayFigures(day, projectId))
    .reduce((sum, day) => ({ commits: sum.commits + day.commits, linesAdded: sum.linesAdded + day.linesAdded, linesRemoved: sum.linesRemoved + day.linesRemoved, mergeRequests: sum.mergeRequests + day.mergeRequests, active: sum.active + (day.commits > 0 || (day.userMs ?? 0) >= 60_000 ? 1 : 0) }), { commits: 0, linesAdded: 0, linesRemoved: 0, mergeRequests: 0, active: 0 }), [calendar.days, thisMonth, projectId])
  const monthName = new Date(`${calendar.to}T12:00:00`).toLocaleDateString('fr-FR', { month: 'long' })

  return (
    <section className="activity-calendar" aria-label="Calendrier d’activité">
      <div className="activity-calendar-head">
        <div>
          <h2>{`${monthName.charAt(0).toUpperCase()}${monthName.slice(1)}`}</h2>
          <p>{`${number(monthTotals.commits)} commit${monthTotals.commits > 1 ? 's' : ''}, +${number(monthTotals.linesAdded)} −${number(monthTotals.linesRemoved)}${monthTotals.mergeRequests > 0 ? `, ${monthTotals.mergeRequests} MR ouverte${monthTotals.mergeRequests > 1 ? 's' : ''}` : ''}, ${monthTotals.active} jour${monthTotals.active > 1 ? 's' : ''} actif${monthTotals.active > 1 ? 's' : ''}`}</p>
        </div>
        {projects.length > 1 ? (
          <div className="activity-calendar-projects" role="radiogroup" aria-label="Projet du calendrier">
            <button type="button" role="radio" aria-checked={projectId === null} className={projectId === null ? 'is-active' : ''} onClick={() => setProjectId(null)}>Tous les projets</button>
            {projects.map((project) => <button type="button" role="radio" key={project.projectId} aria-checked={projectId === project.projectId} className={projectId === project.projectId ? 'is-active' : ''} onClick={() => setProjectId(project.projectId)}>{project.projectName}</button>)}
          </div>
        ) : null}
        <div className="activity-calendar-metric" role="radiogroup" aria-label="Mesure du calendrier">
          <button type="button" role="radio" aria-checked={metric === 'lines'} className={metric === 'lines' ? 'is-active' : ''} onClick={() => setMetric('lines')}>Lignes</button>
          <button type="button" role="radio" aria-checked={metric === 'commits'} className={metric === 'commits' ? 'is-active' : ''} onClick={() => setMetric('commits')}>Commits</button>
        </div>
      </div>
      <div className="activity-calendar-grid" ref={scrollerRef}>
        <div className="activity-calendar-months" aria-hidden="true">
          {months.map((month) => <span key={`${month.label}-${month.column}`} style={{ left: `calc(${month.column} * (var(--cell) + var(--gap)))` }}>{month.label}</span>)}
        </div>
        <div className="activity-calendar-weekdays" aria-hidden="true">{WEEKDAYS.map((label, index) => <span key={index}>{label}</span>)}</div>
        <div className="activity-calendar-weeks">
          {weeks.map((week, column) => week.map((day, row) => {
            if (!day) return <i key={`${column}-${row}`} className="activity-calendar-day is-empty" aria-hidden="true" />
            const level = levelOf(metricValue(day, metric, projectId), sorted)
            const className = `activity-calendar-day is-${level}${day.hasReport ? ' is-report' : ''}${day.day === selectedDay ? ' is-selected' : ''}`
            const title = dayTitle(day, projectId)
            return day.hasReport
              ? <button type="button" key={day.day} className={className} data-day={day.day} data-level={level} title={title} aria-label={title} aria-pressed={day.day === selectedDay} onClick={() => onSelect(day.day)} />
              : <i key={day.day} className={className} data-day={day.day} data-level={level} title={title} role="img" aria-label={title} />
          }))}
        </div>
      </div>
      <div className="activity-calendar-legend" aria-hidden="true">
        <span>moins</span><i /><i className="is-1" /><i className="is-2" /><i className="is-3" /><i className="is-4" /><span>plus</span>
      </div>
    </section>
  )
}
