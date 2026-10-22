import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { getActivityAgenda, getActivityArchive, getCalendarEvents, type AgendaArchive, type AgendaBlock, type AgendaProject, type AgendaRange, type CalendarEvent, type CalendarRange } from './api'

export type AgendaView = 'day' | 'week' | 'archive'

/** La grille commence à 8 h ; la nuit se replie dans une bande au-dessus. */
export const DAY_START_HOUR = 8
const NIGHT_BAND_PX = 30
const HOUR_PX: Record<'day' | 'week', number> = { day: 52, week: 38 }
const FALLBACK_COLOR = '#94a3b8'
const CALENDAR_VISIBLE_KEY = 'pupitre:agenda-google'

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)
const noon = (day: string) => new Date(`${day}T12:00:00`)
export const localDay = (date: Date) => date.toLocaleDateString('en-CA')
export const addDays = (day: string, count: number) => { const date = noon(day); date.setDate(date.getDate() + count); return localDay(date) }
export const mondayOf = (day: string) => addDays(day, -((noon(day).getDay() + 6) % 7))
export const duration = (ms: number) => ms < 60_000 ? '0 min' : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} h`
const clock = (iso: string) => new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })

/** Heure locale décimale d'un instant dans son jour : minuit en fin de bloc vaut 24. */
export function hourOf(iso: string, day: string, isEnd = false): number {
  const hours = (new Date(iso).getTime() - new Date(`${day}T00:00:00`).getTime()) / 3_600_000
  return isEnd && hours === 0 ? 24 : hours
}

export interface PlacedBlock { block: AgendaBlock; column: number; columns: number }

/** Rendez-vous qui touchent le jour : les horaires par chevauchement, les journées entières par leurs bornes (fin exclue). */
export function meetingsOf(events: CalendarEvent[], day: string): { timed: CalendarEvent[]; allDay: CalendarEvent[] } {
  const dayStart = Date.parse(`${day}T00:00:00`)
  const dayEnd = Date.parse(`${addDays(day, 1)}T00:00:00`)
  return {
    timed: events.filter((event) => !event.allDay && Date.parse(event.start) < dayEnd && Date.parse(event.end) > dayStart),
    allDay: events.filter((event) => event.allDay && event.start <= day && event.end > day),
  }
}

/**
 * Colonnes à la Google Agenda : un projet occupe une enveloppe (ses blocs
 * recollés), et le jour ne se divise que là où deux enveloppes se chevauchent.
 */
export function layoutDay(blocks: AgendaBlock[]): PlacedBlock[] {
  const envelopes: Array<{ projectId: string; start: number; end: number; blocks: AgendaBlock[]; column: number }> = []
  for (const projectId of new Set(blocks.map((block) => block.projectId))) {
    const own = blocks.filter((block) => block.projectId === projectId).sort((left, right) => left.start.localeCompare(right.start))
    let current: (typeof envelopes)[number] | null = null
    for (const block of own) {
      const start = Date.parse(block.start)
      const end = Date.parse(block.end)
      if (!current || start > current.end) {
        current = { projectId, start, end, blocks: [], column: 0 }
        envelopes.push(current)
      }
      current.end = Math.max(current.end, end)
      current.blocks.push(block)
    }
  }
  envelopes.sort((left, right) => left.start - right.start || right.end - left.end)
  const placed: PlacedBlock[] = []
  let cluster: typeof envelopes = []
  let columnEnds: number[] = []
  let clusterEnd = -Infinity
  const flush = () => {
    for (const envelope of cluster) for (const block of envelope.blocks) placed.push({ block, column: envelope.column, columns: columnEnds.length })
    cluster = []
    columnEnds = []
  }
  for (const envelope of envelopes) {
    if (envelope.start >= clusterEnd) { flush(); clusterEnd = -Infinity }
    let column = columnEnds.findIndex((end) => end <= envelope.start)
    if (column === -1) { column = columnEnds.length; columnEnds.push(0) }
    columnEnds[column] = envelope.end
    envelope.column = column
    cluster.push(envelope)
    clusterEnd = Math.max(clusterEnd, envelope.end)
  }
  flush()
  return placed
}

function csvCell(value: string | number): string {
  const text = String(value)
  return /[",;\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export function agendaCsv(range: AgendaRange): string {
  const names = new Map(range.projects.map((project) => [project.id, project.name]))
  const rows = [['jour', 'projet', 'source', 'debut', 'fin', 'minutes', 'conversation']]
  for (const block of [...range.blocks].sort((left, right) => left.start.localeCompare(right.start))) {
    rows.push([
      block.day,
      names.get(block.projectId) ?? block.projectId,
      block.source === 'presence' ? 'presence' : 'agent',
      clock(block.start),
      hourOf(block.end, block.day, true) === 24 ? '24:00' : clock(block.end),
      String(Math.round((Date.parse(block.end) - Date.parse(block.start)) / 60_000)),
      block.conversationId ?? '',
    ])
  }
  return rows.map((row) => row.map(csvCell).join(',')).join('\n')
}

export function archiveCsv(archive: AgendaArchive): string {
  const names = new Map(archive.projects.map((project) => [project.id, project.name]))
  const rows = [['semaine', 'projet', 'heures', 'heures_presence']]
  for (const week of archive.weeks) {
    for (const [projectId, figures] of Object.entries(week.projects)) {
      rows.push([week.week, names.get(projectId) ?? projectId, (figures.totalMs / 3_600_000).toFixed(2), (figures.userMs / 3_600_000).toFixed(2)])
    }
  }
  return rows.map((row) => row.map(csvCell).join(',')).join('\n')
}

function download(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function ProjectTotals({ rows, colors, names }: {
  rows: Array<{ projectId: string; totalMs: number; userMs: number }>
  colors: Map<string, string>
  names: Map<string, string>
}) {
  if (rows.length === 0) return <p className="agenda-side-empty">Aucune activité</p>
  return (
    <ul className="agenda-projects">
      {rows.map((row) => {
        const color = colors.get(row.projectId) ?? FALLBACK_COLOR
        const share = row.totalMs > 0 ? Math.min(100, (row.userMs / row.totalMs) * 100) : 0
        return (
          <li key={row.projectId} style={{ '--project': color } as CSSProperties}>
            <span className="agenda-dot" />
            <span className="agenda-project-name">{names.get(row.projectId) ?? row.projectId}</span>
            <strong>{duration(row.totalMs)}</strong>
            <span className="agenda-split" title={`${duration(row.userMs)} de présence`}><i style={{ width: `${share}%` }} /></span>
          </li>
        )
      })}
    </ul>
  )
}

function DayColumn({ day, blocks, meetings, hourPx, today, nowHour, colors, names, onOpenConversation }: {
  day: string
  blocks: AgendaBlock[]
  meetings: CalendarEvent[]
  hourPx: number
  today: boolean
  nowHour: number
  colors: Map<string, string>
  names: Map<string, string>
  onOpenConversation: (projectId: string, conversationId: string) => void
}) {
  const placed = useMemo(() => layoutDay(blocks), [blocks])
  const height = (24 - DAY_START_HOUR) * hourPx
  const pieces = placed.flatMap((item) => {
    const start = hourOf(item.block.start, day)
    const end = hourOf(item.block.end, day, true)
    const out: Array<PlacedBlock & { night: boolean; top: number; size: number }> = []
    if (start < DAY_START_HOUR) {
      const nightEnd = Math.min(end, DAY_START_HOUR)
      out.push({ ...item, night: true, top: (start / DAY_START_HOUR) * NIGHT_BAND_PX, size: Math.max(2, ((nightEnd - start) / DAY_START_HOUR) * NIGHT_BAND_PX) })
    }
    if (end > DAY_START_HOUR) {
      const dayStart = Math.max(start, DAY_START_HOUR)
      out.push({ ...item, night: false, top: (dayStart - DAY_START_HOUR) * hourPx, size: Math.max(3, (end - dayStart) * hourPx) })
    }
    return out
  })
  const meetingPieces = meetings.flatMap((event) => {
    const start = Math.max(0, hourOf(event.start, day))
    const end = Math.min(24, hourOf(event.end, day))
    const out: Array<{ event: CalendarEvent; night: boolean; top: number; size: number }> = []
    if (start < DAY_START_HOUR) out.push({ event, night: true, top: (start / DAY_START_HOUR) * NIGHT_BAND_PX, size: Math.max(2, ((Math.min(end, DAY_START_HOUR) - start) / DAY_START_HOUR) * NIGHT_BAND_PX) })
    if (end > DAY_START_HOUR) {
      const dayStart = Math.max(start, DAY_START_HOUR)
      out.push({ event, night: false, top: (dayStart - DAY_START_HOUR) * hourPx, size: Math.max(3, (end - dayStart) * hourPx) })
    }
    return out
  })
  const renderMeetings = (night: boolean) => meetingPieces.filter((piece) => piece.night === night).map(({ event, top, size }) => (
    <div key={`${event.id}-${night}`} className="agenda-meeting" style={{ top: `${top}px`, height: `${size}px` }} title={`${event.title} · ${clock(event.start)} → ${clock(event.end)}`}>
      {!night && size >= 14 ? <span>{event.title}</span> : null}
    </div>
  ))
  const render = (night: boolean) => pieces.filter((piece) => piece.night === night).map((piece) => {
    const { block } = piece
    const color = colors.get(block.projectId) ?? FALLBACK_COLOR
    const name = names.get(block.projectId) ?? block.projectId
    const minutes = duration(Date.parse(block.end) - Date.parse(block.start))
    const title = `${name} · ${block.source === 'presence' ? 'présence' : 'agent'} · ${clock(block.start)} → ${clock(block.end)} · ${minutes}${block.conversationId ? ' · ouvrir la conversation' : ''}`
    const style = {
      '--project': color,
      top: `${piece.top}px`,
      height: `${piece.size}px`,
      left: `calc(${(piece.column / piece.columns) * 100}% + 1px)`,
      width: `calc(${100 / piece.columns}% - 2px)`,
    } as CSSProperties
    const label = !night && piece.size >= 20 && piece.columns <= 2 ? <span>{name}</span> : null
    const className = `agenda-block is-${block.source}`
    return block.conversationId
      ? <button type="button" key={`${block.projectId}-${block.source}-${block.start}-${night}`} className={className} style={style} title={title} aria-label={title} onClick={() => onOpenConversation(block.projectId, block.conversationId!)}>{label}</button>
      : <div key={`${block.projectId}-${block.source}-${block.start}-${night}`} className={className} style={style} title={title}>{label}</div>
  })
  return (
    <div className={`agenda-column${today ? ' is-today' : ''}`} data-day={day}>
      <div className="agenda-night" style={{ height: `${NIGHT_BAND_PX}px` }}>{renderMeetings(true)}{render(true)}</div>
      <div className="agenda-hours-area" style={{ height: `${height}px` }}>
        {Array.from({ length: 24 - DAY_START_HOUR }, (_, index) => <i key={index} className="agenda-hour-line" style={{ top: `${index * hourPx}px` }} />)}
        {renderMeetings(false)}
        {render(false)}
        {today && nowHour >= DAY_START_HOUR ? <i className="agenda-now" style={{ top: `${(nowHour - DAY_START_HOUR) * hourPx}px` }} /> : null}
      </div>
    </div>
  )
}

function Calendar({ range, meetings, days, view, today, onOpenConversation, onOpenDay }: {
  range: AgendaRange
  meetings: CalendarEvent[]
  days: string[]
  view: 'day' | 'week'
  today: string
  onOpenConversation: (projectId: string, conversationId: string) => void
  onOpenDay: (day: string) => void
}) {
  const colors = useMemo(() => new Map(range.projects.map((project) => [project.id, project.color])), [range.projects])
  const names = useMemo(() => new Map(range.projects.map((project) => [project.id, project.name])), [range.projects])
  const byDay = useMemo(() => {
    const out = new Map<string, AgendaBlock[]>()
    for (const block of range.blocks) out.set(block.day, [...(out.get(block.day) ?? []), block])
    return out
  }, [range.blocks])
  const now = new Date()
  const nowHour = now.getHours() + now.getMinutes() / 60
  const hourPx = HOUR_PX[view]
  const totals = new Map<string, { projectId: string; totalMs: number; userMs: number }>()
  for (const day of days) {
    for (const [projectId, figures] of Object.entries(range.totals[day] ?? {})) {
      const entry = totals.get(projectId) ?? { projectId, totalMs: 0, userMs: 0 }
      entry.totalMs += figures.totalMs
      entry.userMs += figures.userMs
      totals.set(projectId, entry)
    }
  }
  const totalMs = [...totals.values()].reduce((sum, row) => sum + row.totalMs, 0)
  const userMs = [...totals.values()].reduce((sum, row) => sum + row.userMs, 0)
  const rows = [...totals.values()].filter((row) => row.totalMs >= 60_000).sort((left, right) => right.totalMs - left.totalMs)
  const dayTotal = (day: string) => Object.values(range.totals[day] ?? {}).reduce((sum, figures) => sum + figures.totalMs, 0)

  return (
    <div className="agenda-body">
      <div className="agenda-grid" style={{ '--columns': days.length } as CSSProperties}>
        <div className="agenda-corner" />
        {days.map((day) => {
          const ms = dayTotal(day)
          const allDay = meetingsOf(meetings, day).allDay.map((event) => event.title).join(' · ')
          return (
            <button type="button" key={day} className={`agenda-day-head${day === today ? ' is-today' : ''}`} onClick={() => onOpenDay(day)} title="Lire le journal de ce jour">
              <span>{capitalize(noon(day).toLocaleDateString('fr-FR', { weekday: view === 'day' ? 'long' : 'short' }))}</span>
              <strong>{noon(day).getDate()}</strong>
              <small>{ms >= 60_000 ? duration(ms) : '—'}</small>
              {allDay ? <em className="agenda-allday" title={allDay}>{allDay}</em> : null}
            </button>
          )
        })}
        <div className="agenda-gutter">
          <span className="agenda-night-label" style={{ height: `${NIGHT_BAND_PX}px` }}>0–8 h</span>
          <div style={{ position: 'relative', height: `${(24 - DAY_START_HOUR) * hourPx}px` }}>
            {Array.from({ length: 24 - DAY_START_HOUR }, (_, index) => <span key={index} style={{ top: `${index * hourPx}px` }}>{String(DAY_START_HOUR + index).padStart(2, '0')} h</span>)}
          </div>
        </div>
        {days.map((day) => (
          <DayColumn key={day} day={day} blocks={byDay.get(day) ?? []} meetings={meetingsOf(meetings, day).timed} hourPx={hourPx} today={day === today} nowHour={nowHour} colors={colors} names={names} onOpenConversation={onOpenConversation} />
        ))}
      </div>
      <aside className="agenda-side">
        <div className="agenda-total">
          <span>Temps projet {view === 'day' ? 'du jour' : 'de la semaine'}</span>
          <strong>{duration(totalMs)}</strong>
          <small>dont {duration(userMs)} de présence</small>
        </div>
        <ProjectTotals rows={rows} colors={colors} names={names} />
        <button type="button" className="secondary-button" disabled={range.blocks.length === 0} onClick={() => download(`pupitre-temps-${days[0]}${days.length > 1 ? `-${days[days.length - 1]}` : ''}.csv`, agendaCsv(range))}>
          Exporter en CSV
        </button>
      </aside>
    </div>
  )
}

function Archive({ archive, onOpenWeek, onYear }: { archive: AgendaArchive; onOpenWeek: (week: string) => void; onYear: (year: number) => void }) {
  const colors = useMemo(() => new Map(archive.projects.map((project: AgendaProject) => [project.id, project.color])), [archive.projects])
  const names = useMemo(() => new Map(archive.projects.map((project: AgendaProject) => [project.id, project.name])), [archive.projects])
  const weeks = [...archive.weeks].reverse()
  const weekTotal = (week: AgendaArchive['weeks'][number]) => Object.values(week.projects).reduce((sum, figures) => sum + figures.totalMs, 0)
  const max = Math.max(1, ...weeks.map(weekTotal))
  const totals = new Map<string, { projectId: string; totalMs: number; userMs: number }>()
  for (const week of weeks) {
    for (const [projectId, figures] of Object.entries(week.projects)) {
      const entry = totals.get(projectId) ?? { projectId, totalMs: 0, userMs: 0 }
      entry.totalMs += figures.totalMs
      entry.userMs += figures.userMs
      totals.set(projectId, entry)
    }
  }
  const rows = [...totals.values()].sort((left, right) => right.totalMs - left.totalMs)
  let month = ''
  return (
    <div className="agenda-body">
      <div className="agenda-archive">
        {weeks.length === 0 ? <p className="agenda-side-empty">Aucune activité enregistrée en {archive.year}.</p> : null}
        {weeks.map((week) => {
          const label = capitalize(noon(week.week).toLocaleDateString('fr-FR', { month: 'long' }))
          const heading = label !== month ? <h3 className="agenda-month">{label}</h3> : null
          month = label
          const total = weekTotal(week)
          const entries = Object.entries(week.projects).sort((left, right) => right[1].totalMs - left[1].totalMs)
          return (
            <div key={week.week}>
              {heading}
              <button type="button" className="agenda-week" onClick={() => onOpenWeek(week.week)} title={entries.map(([id, figures]) => `${names.get(id) ?? id} ${duration(figures.totalMs)}`).join(' · ')}>
                <span className="agenda-week-label">{noon(week.week).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })} → {noon(addDays(week.week, 6)).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}</span>
                <span className="agenda-week-bar" style={{ width: `${Math.max(3, (total / max) * 100)}%` }}>
                  {entries.map(([id, figures]) => <i key={id} style={{ width: `${(figures.totalMs / total) * 100}%`, background: colors.get(id) ?? FALLBACK_COLOR }} />)}
                </span>
                <strong>{duration(total)}</strong>
              </button>
            </div>
          )
        })}
      </div>
      <aside className="agenda-side">
        {archive.years.length > 1 ? (
          <div className="agenda-segmented" role="group" aria-label="Année">
            {archive.years.map((year) => <button type="button" key={year} className={year === archive.year ? 'is-active' : ''} onClick={() => onYear(year)}>{year}</button>)}
          </div>
        ) : null}
        <div className="agenda-total">
          <span>Temps projet en {archive.year}</span>
          <strong>{duration(rows.reduce((sum, row) => sum + row.totalMs, 0))}</strong>
          <small>{weeks.length} semaine{weeks.length > 1 ? 's' : ''} active{weeks.length > 1 ? 's' : ''}</small>
        </div>
        <ProjectTotals rows={rows} colors={colors} names={names} />
        <button type="button" className="secondary-button" disabled={weeks.length === 0} onClick={() => download(`pupitre-temps-${archive.year}.csv`, archiveCsv(archive))}>
          Exporter l’année en CSV
        </button>
      </aside>
    </div>
  )
}

export function ActivityAgenda({ onOpenConversation, onOpenDay }: {
  onOpenConversation: (projectId: string, conversationId: string) => void
  onOpenDay: (day: string) => void
}) {
  const today = localDay(new Date())
  const [view, setView] = useState<AgendaView>('week')
  const [anchor, setAnchor] = useState(today)
  const [year, setYear] = useState(new Date().getFullYear())
  const [range, setRange] = useState<AgendaRange | null>(null)
  const [archive, setArchive] = useState<AgendaArchive | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showCalendar, setShowCalendar] = useState(() => window.localStorage.getItem(CALENDAR_VISIBLE_KEY) !== '0')
  const [calendar, setCalendar] = useState<(CalendarRange & { from: string; to: string }) | null>(null)
  const days = view === 'day' ? [anchor] : Array.from({ length: 7 }, (_, index) => addDays(mondayOf(anchor), index))
  const from = days[0]!
  const to = days[days.length - 1]!

  useEffect(() => {
    if (view === 'archive') return
    let cancelled = false
    getActivityAgenda(from, to)
      .then((next) => { if (!cancelled) { setRange(next); setError(null) } })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : 'Agenda indisponible') })
    return () => { cancelled = true }
  }, [view, from, to])
  useEffect(() => {
    if (view === 'archive' || !showCalendar) return
    let cancelled = false
    getCalendarEvents(from, to)
      .then((next) => { if (!cancelled) setCalendar({ ...next, from, to }) })
      .catch(() => { if (!cancelled) setCalendar({ configured: true, events: [], error: 'Google Agenda indisponible', from, to }) })
    return () => { cancelled = true }
  }, [view, from, to, showCalendar])
  useEffect(() => {
    if (view !== 'archive') return
    let cancelled = false
    getActivityArchive(year)
      .then((next) => { if (!cancelled) { setArchive(next); setError(null) } })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : 'Archives indisponibles') })
    return () => { cancelled = true }
  }, [view, year])

  const step = view === 'day' ? 1 : 7
  const period = view === 'archive'
    ? `Semaines de ${year}`
    : view === 'day'
      ? capitalize(noon(anchor).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }))
      : `Semaine du ${noon(from).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })} au ${noon(to).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}`
  const loaded = view === 'archive' ? archive?.year === year : range?.from === from && range.to === to
  const shownCalendar = showCalendar && calendar?.from === from && calendar.to === to ? calendar : null
  const toggleCalendar = () => {
    window.localStorage.setItem(CALENDAR_VISIBLE_KEY, showCalendar ? '0' : '1')
    setShowCalendar(!showCalendar)
  }

  return (
    <section className="agenda" aria-label="Agenda du temps projet">
      <div className="agenda-toolbar">
        <div className="agenda-segmented" role="group" aria-label="Vue">
          {(['day', 'week', 'archive'] as const).map((item) => (
            <button type="button" key={item} className={view === item ? 'is-active' : ''} onClick={() => setView(item)}>
              {item === 'day' ? 'Jour' : item === 'week' ? 'Semaine' : 'Archives'}
            </button>
          ))}
        </div>
        {view === 'archive' ? null : (
          <div className="agenda-nav">
            <button type="button" aria-label="Période précédente" onClick={() => setAnchor(addDays(anchor, -step))}>‹</button>
            <button type="button" className="agenda-today" onClick={() => setAnchor(today)}>Aujourd’hui</button>
            <button type="button" aria-label="Période suivante" onClick={() => setAnchor(addDays(anchor, step))}>›</button>
          </div>
        )}
        <h2 className="agenda-period">{period}</h2>
        {view === 'archive' ? null : (
          <span className="agenda-legend">
            <i className="is-presence" />présence <i className="is-agent" />agent
            <button type="button" className="agenda-calendar-toggle" aria-pressed={showCalendar} onClick={toggleCalendar} title={showCalendar ? 'Cacher les rendez-vous Google Agenda' : 'Afficher les rendez-vous Google Agenda'}>
              <i className="is-meeting" />Google Agenda
            </button>
          </span>
        )}
      </div>
      {error ? <p className="modal-error" role="alert">{error}</p> : null}
      {view !== 'archive' && shownCalendar && !shownCalendar.configured ? (
        <p className="agenda-calendar-note">Pour voir vos rendez-vous, collez l’adresse secrète au format iCal de votre Google Agenda dans Réglages, rubrique Tokens d’intégration.</p>
      ) : null}
      {view !== 'archive' && shownCalendar?.error ? <p className="agenda-calendar-note">Google Agenda : {shownCalendar.error}</p> : null}
      {!loaded ? <div className="empty-state"><p>Chargement de l’agenda…</p></div>
        : view === 'archive'
          ? <Archive archive={archive!} onYear={setYear} onOpenWeek={(week) => { setAnchor(week); setView('week') }} />
          : <Calendar range={range!} meetings={shownCalendar?.events ?? []} days={days} view={view} today={today} onOpenConversation={onOpenConversation} onOpenDay={onOpenDay} />}
    </section>
  )
}
