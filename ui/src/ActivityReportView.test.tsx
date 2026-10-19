import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { ActivityMotif, ActivityReportIndex } from './api'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render, waitFor } = await import('@testing-library/react')
const { ActivityReportView, rankMotifs, risingMotifs } = await import('./ActivityReportView')
const { addDays, localDay } = await import('./ActivityAgenda')

const defaultFetch = globalThis.fetch
afterEach(() => {
  cleanup()
  globalThis.fetch = defaultFetch
})

function motif(id: string, overrides: Partial<ActivityMotif> = {}): ActivityMotif {
  return {
    id, project_id: 'a', kind: 'practice', title: `Motif ${id}`, statement: 'Constat.', status: 'open', first_seen_day: '2026-10-01', last_seen_day: '2026-10-10',
    returned_at: null, todo_id: null, stars: null, stars_previous: null, stars_changed_day: null, rank: null, rank_reason: null, evidence: [],
    ...overrides,
  }
}

test('le top suit le rang du tri, la réserve garde le reste, et sans tri la fraîcheur décide', () => {
  const ranked = Array.from({ length: 12 }, (_, index) => motif(`m${index}`, { rank: index < 10 ? 10 - index : null, stars: index % 5 + 1 }))
  const result = rankMotifs([...ranked, motif('ferme', { status: 'handled', rank: 1 })])
  expect(result.triaged).toBe(true)
  expect(result.top.map((item) => item.id)).toEqual(['m9', 'm8', 'm7', 'm6', 'm5', 'm4', 'm3', 'm2', 'm1', 'm0'])
  expect(result.reserve.map((item) => item.id)).toEqual(['m11', 'm10'])

  const fresh = rankMotifs([motif('vieux', { last_seen_day: '2026-09-01' }), motif('neuf', { last_seen_day: '2026-10-18' })])
  expect(fresh).toEqual(expect.objectContaining({ triaged: false }))
  expect(fresh.top.map((item) => item.id)).toEqual(['neuf', 'vieux'])
})

test('en hausse : les motifs ouverts dont la note a monté, ou apparus à cinq étoiles, dans les sept derniers jours', () => {
  const today = '2026-10-19'
  const rising = risingMotifs([
    motif('plus2', { stars: 5, stars_previous: 3, stars_changed_day: '2026-10-18' }),
    motif('plus1', { stars: 4, stars_previous: 3, stars_changed_day: '2026-10-17' }),
    motif('baisse', { stars: 2, stars_previous: 4, stars_changed_day: '2026-10-18' }),
    motif('ancien', { stars: 5, stars_previous: 2, stars_changed_day: '2026-10-01' }),
    motif('ecarte', { status: 'dismissed', stars: 5, stars_previous: 1, stars_changed_day: '2026-10-18' }),
    motif('premier', { stars: 5, stars_previous: null, stars_changed_day: null }),
    motif('nouveau5', { stars: 5, stars_previous: null, first_seen_day: '2026-10-17', last_seen_day: '2026-10-18' }),
    motif('nouveau4', { stars: 4, stars_previous: null, first_seen_day: '2026-10-17' }),
    motif('nouveau-ecarte', { status: 'dismissed', stars: 5, stars_previous: null, first_seen_day: '2026-10-17' }),
  ], today)
  expect(rising.map((item) => item.id)).toEqual(['plus2', 'nouveau5', 'plus1'])
})

test('le rapport ouvre l’agenda, puis le recul montre la hausse, les chips projet et dix constats au plus', async () => {
  const today = localDay(new Date())
  const motifs = [
    ...Array.from({ length: 12 }, (_, index) => motif(`a${index}`, { rank: index < 10 ? index + 1 : null, stars: index < 10 ? 3 : 1, rank_reason: `Raison ${index}` })),
    motif('hausse', { project_id: 'b', rank: 1, stars: 5, stars_previous: 3, stars_changed_day: addDays(today, -1), title: 'Saturation des ports' }),
  ]
  const index: ActivityReportIndex = {
    days: [],
    retro: { motifs, projects: [{ id: 'a', name: 'Pupitre', color: '#f06595' }, { id: 'b', name: 'Affilae', color: '#ff922b' }] },
    run: { running: false, runningDay: null },
  }
  globalThis.fetch = mock(async (input) => {
    const url = String(input)
    if (url.includes('/agenda')) return Response.json({ from: today, to: today, blocks: [], totals: {}, projects: [] })
    if (url.endsWith('/api/activity-reports')) return Response.json(index)
    return Response.json({ error: 'rapport inconnu' }, { status: 404 })
  }) as unknown as typeof fetch
  const view = render(createElement(ActivityReportView, { onOpenConversation: () => {} }))

  await waitFor(() => expect(view.container.querySelector('.report-tabs .is-active')!.textContent).toBe('Agenda'))
  expect(view.container.querySelector('.report-tab-badge')!.textContent).toBe('▲ 1')
  fireEvent.click(view.getByText('Recul'))

  expect(view.container.querySelectorAll('.recul-rising .motif')).toHaveLength(1)
  expect(view.container.querySelector('.recul-rising .motif-kind')!.textContent).toContain('Affilae')
  expect(view.container.querySelector('.recul-rising .motif-rise')!.textContent).toBe(`+2 le ${new Date(`${addDays(today, -1)}T12:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}`)
  expect([...view.container.querySelectorAll('.recul-chips button')].map((chip) => chip.textContent)).toEqual(['Pupitre10', 'Affilae1'])
  const top = view.container.querySelectorAll('.recul > .motifs > .motif')
  expect(top).toHaveLength(10)
  expect(top[0]!.querySelector('.motif-rank')!.textContent).toBe('1')
  expect(top[0]!.querySelector('.motif-stars')!.getAttribute('aria-label')).toBe('3 étoiles sur 5')
  expect(view.container.querySelector('.recul-reserve summary')!.textContent).toBe('2 autres constats en réserve')

  fireEvent.click(view.container.querySelectorAll('.recul-chips button')[1]!)
  expect(view.container.querySelectorAll('.recul > .motifs > .motif')).toHaveLength(1)
})
