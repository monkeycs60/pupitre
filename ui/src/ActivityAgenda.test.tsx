import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { AgendaArchive, AgendaBlock, AgendaRange } from './api'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render, waitFor } = await import('@testing-library/react')
const { ActivityAgenda, addDays, agendaCsv, hourOf, layoutDay, localDay, mondayOf } = await import('./ActivityAgenda')

const defaultFetch = globalThis.fetch
afterEach(() => {
  cleanup()
  globalThis.fetch = defaultFetch
})

const iso = (day: string, hour: number, minute = 0) => {
  const date = new Date(`${day}T00:00:00`)
  date.setHours(hour, minute, 0, 0)
  return date.toISOString()
}

function block(day: string, projectId: string, from: [number, number], to: [number, number], source: AgendaBlock['source'] = 'presence', conversationId: string | null = null): AgendaBlock {
  return { projectId, source, day, start: iso(day, ...from), end: to[0] === 24 ? iso(addDays(day, 1), 0) : iso(day, ...to), conversationId }
}

test('les colonnes ne se partagent que là où deux projets se chevauchent', () => {
  const day = '2026-10-14'
  const placed = layoutDay([
    block(day, 'a', [9, 0], [10, 0]),
    block(day, 'a', [10, 0], [11, 0], 'agent'),
    block(day, 'b', [10, 30], [12, 0]),
    block(day, 'c', [14, 0], [15, 0]),
  ])
  const columns = Object.fromEntries(placed.map((item) => [`${item.block.projectId}-${item.block.start}`, [item.column, item.columns]]))
  expect(columns[`a-${iso(day, 9)}`]).toEqual([0, 2])
  expect(columns[`a-${iso(day, 10)}`]).toEqual([0, 2])
  expect(columns[`b-${iso(day, 10, 30)}`]).toEqual([1, 2])
  expect(columns[`c-${iso(day, 14)}`]).toEqual([0, 1])
})

test('minuit en fin de bloc vaut 24 h, et le CSV écrit 24:00', () => {
  const day = '2026-10-14'
  const late = block(day, 'a', [23, 30], [24, 0], 'agent', 'c1')
  expect(hourOf(late.end, day, true)).toBe(24)
  expect(hourOf(late.start, day)).toBe(23.5)
  const csv = agendaCsv({ from: day, to: day, blocks: [late], totals: {}, projects: [{ id: 'a', name: 'Pupitre, dev', color: '#f06595' }] })
  expect(csv.split('\n')).toEqual(['jour,projet,source,debut,fin,minutes,conversation', `${day},"Pupitre, dev",agent,23:30,24:00,30,c1`])
})

test('la semaine part du lundi, replie la nuit et ouvre la conversation ou le journal du jour', async () => {
  const today = localDay(new Date())
  const monday = mondayOf(today)
  const wednesday = addDays(monday, 2)
  const range: AgendaRange = {
    from: monday,
    to: addDays(monday, 6),
    blocks: [
      block(wednesday, 'a', [6, 0], [7, 0], 'agent', 'nuit'),
      block(wednesday, 'a', [7, 30], [9, 0], 'presence', 'matin'),
      block(wednesday, 'b', [14, 0], [16, 0], 'agent'),
    ],
    totals: { [wednesday]: { a: { totalMs: 9_000_000, userMs: 5_400_000, agentMs: 3_600_000 }, b: { totalMs: 7_200_000, userMs: 0, agentMs: 7_200_000 } } },
    projects: [{ id: 'a', name: 'Pupitre', color: '#f06595' }, { id: 'b', name: 'Affilae', color: '#ff922b' }],
  }
  const archive: AgendaArchive = {
    year: new Date().getFullYear(),
    years: [new Date().getFullYear()],
    weeks: [{ week: addDays(monday, -7), projects: { a: { totalMs: 3_600_000, userMs: 0 } } }, { week: monday, projects: { a: { totalMs: 9_000_000, userMs: 5_400_000 }, b: { totalMs: 7_200_000, userMs: 0 } } }],
    projects: range.projects,
  }
  const requests: string[] = []
  globalThis.fetch = mock(async (input) => {
    requests.push(String(input))
    return Response.json(String(input).includes('/archive') ? archive : range)
  }) as unknown as typeof fetch
  const onOpenConversation = mock(() => {})
  const onOpenDay = mock(() => {})
  const view = render(createElement(ActivityAgenda, { onOpenConversation, onOpenDay }))

  await waitFor(() => expect(view.container.querySelectorAll('.agenda-column')).toHaveLength(7))
  expect(requests[0]).toContain(`from=${monday}&to=${addDays(monday, 6)}`)
  const heads = [...view.container.querySelectorAll('.agenda-day-head')]
  expect(heads[0]!.textContent).toMatch(/^Lun/)
  expect(heads[2]!.textContent).toContain('4,5 h')

  const column = view.container.querySelector(`.agenda-column[data-day="${wednesday}"]`)!
  expect(column.querySelectorAll('.agenda-night .agenda-block')).toHaveLength(2)
  expect(column.querySelectorAll('.agenda-hours-area .agenda-block')).toHaveLength(2)
  const morning = column.querySelector<HTMLElement>('.agenda-hours-area .agenda-block.is-presence')!
  expect(morning.style.top).toBe('0px')
  expect(morning.style.height).toBe('38px')
  expect(column.querySelector<HTMLElement>('.agenda-hours-area .agenda-block.is-agent')!.tagName).toBe('DIV')

  fireEvent.click(morning)
  expect(onOpenConversation).toHaveBeenCalledWith('a', 'matin')
  fireEvent.click(heads[2]!)
  expect(onOpenDay).toHaveBeenCalledWith(wednesday)
  expect(view.container.querySelector('.agenda-total strong')!.textContent).toBe('4,5 h')
  expect([...view.container.querySelectorAll('.agenda-project-name')].map((node) => node.textContent)).toEqual(['Pupitre', 'Affilae'])

  fireEvent.click(view.getByText('Archives'))
  await waitFor(() => expect(view.container.querySelectorAll('.agenda-week')).toHaveLength(2))
  expect(view.container.querySelector('.agenda-week strong')!.textContent).toBe('4,5 h')
  fireEvent.click(view.container.querySelectorAll('.agenda-week')[1]!)
  await waitFor(() => expect(requests.at(-1)).toContain(`from=${addDays(monday, -7)}`))
})
