import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { UsageReport } from './api'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render, waitFor } = await import('@testing-library/react')
const { ActivityReportView } = await import('./ActivityReportView')
const { addDays, localDay } = await import('./ActivityAgenda')
const { USAGE_AREAS, USAGE_CATALOG } = await import('./usageCatalog')

const defaultFetch = globalThis.fetch
afterEach(() => {
  cleanup()
  globalThis.fetch = defaultFetch
})

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

function usageReport(days: number, counts: Record<string, { count: number; lastAt: string }>, activeDays: Record<number, number>, background: UsageReport['background'], jarvis: UsageReport['jarvis'] = { questions: [], actions: [] }): UsageReport {
  const today = localDay(new Date())
  return {
    since: `${addDays(today, 1 - days)}T00:00:00.000Z`,
    until: new Date().toISOString(),
    catalog: USAGE_CATALOG.map((entry) => ({
      feature: entry.feature,
      label: entry.label,
      area: entry.area,
      count: counts[entry.feature]?.count ?? 0,
      lastAt: counts[entry.feature]?.lastAt ?? null,
    })),
    events: [],
    daily: Array.from({ length: days }, (_, index) => ({ day: addDays(today, index + 1 - days), count: activeDays[days - 1 - index] ?? 0 })),
    background,
    jarvis,
  }
}

const USED = {
  'composer.send': { count: 1_250, lastAt: minutesAgo(5) },
  'conversation.open': { count: 7, lastAt: minutesAgo(180) },
  'project.tab.tickets': { count: 2, lastAt: minutesAgo(2 * 24 * 60) },
  'nav.report': { count: 1, lastAt: minutesAgo(3 * 24 * 60) },
}

function serve(reports: Record<number, UsageReport>) {
  const requested: number[] = []
  globalThis.fetch = mock(async (input) => {
    const url = String(input)
    const usage = url.match(/\/api\/usage\?days=(\d+)$/)
    if (usage) {
      requested.push(Number(usage[1]))
      return Response.json(reports[Number(usage[1])])
    }
    if (url.endsWith('/api/activity-reports')) return Response.json({ days: [], retro: { motifs: [], projects: [] }, run: { running: false, runningDay: null } })
    return Response.json({ error: 'inconnu' }, { status: 404 })
  }) as unknown as typeof fetch
  return requested
}

const texts = (root: Element, selector: string) => [...root.querySelectorAll(selector)].map((node) => node.textContent)

test('l’onglet Usage met en avant les fonctions jamais utilisées, puis classe les autres et le travail de fond', async () => {
  const requested = serve({
    30: usageReport(30, USED, { 0: 1_200, 1: 50, 3: 10 }, [{ kind: 'veille des conversations', count: 120 }, { kind: 'reprise', count: 4 }]),
  })
  const view = render(createElement(ActivityReportView, { initialTab: 'usage', onOpenConversation: () => {} }))

  await waitFor(() => expect(view.container.querySelector('.usage-table')).not.toBeNull())
  expect(requested).toEqual([30])
  expect(view.container.querySelector('.report-tabs .is-active')!.textContent).toBe('Usage')
  expect(view.container.querySelector('.agenda-segmented [aria-pressed="true"]')!.textContent).toBe('30 jours')
  const firstDay = new Date(`${addDays(localDay(new Date()), -3)}T12:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })
  expect(view.container.querySelector('.usage-meta')!.textContent).toBe(`1 260 interactions · 3 jours actifs sur 30 · première le ${firstDay}`)

  const unused = view.container.querySelector('.usage-unused')!
  const unusedLabels = texts(unused, 'li')
  expect(unusedLabels).toHaveLength(USAGE_CATALOG.length - Object.keys(USED).length)
  expect(unused.querySelector('h2 small')!.textContent).toBe(String(unusedLabels.length))
  expect(unusedLabels).toContain('Onglet Sentry')
  expect(unusedLabels).not.toContain('Onglet Tickets')
  expect(unusedLabels).not.toContain('Envoyer un message')
  expect(new Set(unusedLabels).size).toBe(unusedLabels.length)
  expect(texts(unused, 'h3')).toEqual(USAGE_AREAS.filter((area) => USAGE_CATALOG.some((entry) => entry.area === area && !(entry.feature in USED))))

  const [usedTable, backgroundTable] = [...view.container.querySelectorAll('.usage-table')]
  const usedRows = [...usedTable!.querySelectorAll('tbody tr')].map((row) => texts(row, 'td'))
  expect(usedRows).toEqual([
    ['Envoyer un message', 'Conversation', '1 250', 'il y a 5 min'],
    ['Ouvrir une conversation', 'Liste', '7', 'il y a 3 h'],
    ['Onglet Tickets', 'Projet', '2', 'il y a 2 j'],
    ['Rapport', 'Navigation', '1', 'il y a 3 j'],
  ])
  expect(texts(backgroundTable!, 'tbody td')).toEqual(['Veille des conversations', '120', 'Reprise', '4'])
})

test('changer de période recharge l’usage, et une période sans interaction ne liste aucune fonction comme inutilisée', async () => {
  const requested = serve({
    30: usageReport(30, USED, { 0: 3 }, []),
    7: usageReport(7, {}, {}, []),
  })
  const view = render(createElement(ActivityReportView, { initialTab: 'usage', onOpenConversation: () => {} }))
  await waitFor(() => expect(view.container.querySelector('.usage-unused')).not.toBeNull())

  fireEvent.click(view.getByText('7 jours'))

  await waitFor(() => expect(view.container.querySelector('.usage-unused')).toBeNull())
  expect(requested).toEqual([30, 7])
  expect(view.container.querySelector('.agenda-segmented [aria-pressed="true"]')!.textContent).toBe('7 jours')
  expect(view.container.querySelector('.usage-meta')!.textContent).toBe('0 interaction · 0 jour actif sur 7')
  expect(texts(view.container, '.usage-note')).toEqual([
    'Aucune interaction mesurée sur la période : rien à conclure sur les fonctions suivies.',
    'Aucun appel automatique sur la période.',
  ])
  expect(view.container.querySelectorAll('.usage-table')).toHaveLength(0)
})

test('l’onglet Usage montre qui a choisi le modèle de Jarvis, en combien de temps, et ce que deviennent ses actions', async () => {
  serve({
    30: usageReport(30, USED, { 0: 3 }, [], {
      questions: [
        { path: 'haiku', count: 12, failed: 1, medianSeconds: 9.6 },
        { path: 'router', count: 3, failed: 0, medianSeconds: 41.2 },
        { path: 'fast', count: 1, failed: 0, medianSeconds: null },
      ],
      actions: [
        { kind: 'open', proposed: 9, done: 6, failed: 0, ignored: 1 },
        { kind: 'archive', proposed: 2, done: 0, failed: 1, ignored: 1 },
      ],
    }),
  })
  const view = render(createElement(ActivityReportView, { initialTab: 'usage', onOpenConversation: () => {} }))
  await waitFor(() => expect(view.getByText('Qui a choisi le modèle')).toBeTruthy())

  expect(texts(view.container, '.usage-section')).toContain('Jarvis 16 questions')
  const [, paths, actions] = [...view.container.querySelectorAll('.usage-table')]
  expect([...paths!.querySelectorAll('tbody tr')].map((row) => texts(row, 'td'))).toEqual([
    ['Haiku 5.5 seul', '12', '9,6 s', '1'],
    ['Routeur, puis Opus 5.5', '3', '41,2 s', '0'],
    ['Mode Rapide', '1', '—', '0'],
  ])
  expect([...actions!.querySelectorAll('tbody tr')].map((row) => texts(row, 'td'))).toEqual([
    ['Ouvrir et surligner', '9', '6', '1', '0'],
    ['Archiver', '2', '0', '1', '1'],
  ])
})
