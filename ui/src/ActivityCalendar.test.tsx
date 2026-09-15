import { afterEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { ActivityCalendarDay } from './api'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render } = await import('@testing-library/react')
const { ActivityCalendar, activeValues, dayTitle, levelOf, weeksOf } = await import('./ActivityCalendar')

afterEach(cleanup)

function day(iso: string, commits = 0, lines = 0, hasReport = false): ActivityCalendarDay {
  return { day: iso, commits, linesAdded: lines, linesRemoved: 0, userMs: 0, hasReport, projects: commits > 0 ? [{ projectId: 'p', projectName: 'Pupitre', commits, linesAdded: lines, linesRemoved: 0 }] : [] }
}

function range(from: string, to: string): ActivityCalendarDay[] {
  const out: ActivityCalendarDay[] = []
  for (const cursor = new Date(`${from}T12:00:00`); cursor <= new Date(`${to}T12:00:00`); cursor.setDate(cursor.getDate() + 1)) {
    out.push(day(cursor.toLocaleDateString('en-CA')))
  }
  return out
}

test('les niveaux vont de 0 pour un jour vide à 4 pour le maximum, les semaines commencent le lundi', () => {
  const sorted = activeValues([0, 80, 0, 10, 20, 30, 40, 50, 60, 70])
  expect(sorted).toEqual([10, 20, 30, 40, 50, 60, 70, 80])
  expect(levelOf(0, sorted)).toBe(0)
  expect(levelOf(10, sorted)).toBe(1)
  expect(levelOf(30, sorted)).toBe(2)
  expect(levelOf(55, sorted)).toBe(3)
  expect(levelOf(80, sorted)).toBe(4)
  expect(levelOf(5, activeValues([5]))).toBe(4)
  const weeks = weeksOf(range('2026-09-02', '2026-09-15'))
  expect(weeks).toHaveLength(3)
  expect(weeks[0]!.slice(0, 2)).toEqual([null, null])
  expect(weeks[0]![2]!.day).toBe('2026-09-02')
  expect(weeks[2]!.filter(Boolean)).toHaveLength(2)
  expect(dayTitle(day('2026-09-15', 3, 40, true))).toBe('mar. 15 sept. : 3 commits, +40 −0 (Pupitre 3). Ouvrir le rapport')
})

test('rend une case par jour, ne rend cliquables que les jours avec rapport, et bascule de mesure', () => {
  const days = range('2026-08-31', '2026-09-15')
  days[14] = day('2026-09-14', 1, 5_000, false)
  days[15] = day('2026-09-15', 10, 50, true)
  const selected: string[] = []
  const { container, getByRole } = render(createElement(ActivityCalendar, { calendar: { from: '2026-08-31', to: '2026-09-15', days }, selectedDay: null, onSelect: (value) => selected.push(value) }))
  expect(container.querySelectorAll('.activity-calendar-day:not(.is-empty)')).toHaveLength(16)
  expect(container.querySelectorAll('button.activity-calendar-day')).toHaveLength(1)
  expect(container.querySelector('[data-day="2026-09-14"]')?.getAttribute('data-level')).toBe('4')
  expect(container.querySelector('[data-day="2026-09-15"]')?.getAttribute('data-level')).toBe('1')
  fireEvent.click(getByRole('radio', { name: 'Commits' }))
  expect(container.querySelector('[data-day="2026-09-15"]')?.getAttribute('data-level')).toBe('4')
  expect(container.querySelector('[data-day="2026-09-14"]')?.getAttribute('data-level')).toBe('1')
  fireEvent.click(container.querySelector('button.activity-calendar-day')!)
  expect(selected).toEqual(['2026-09-15'])
  expect(container.querySelector('.activity-calendar-head p')?.textContent?.replace(/\u202f|\u00a0/g, ' ')).toBe('11 commits, +5 050 −0, 2 jours actifs')
})
