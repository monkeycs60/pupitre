import { afterEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { SidecarJournal } from './types'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, render, screen } = await import('@testing-library/react')
const { SidecarJournalCard } = await import('./SidecarJournalCard')

afterEach(cleanup)

const journal: SidecarJournal = {
  instances: [
    { name: 'stable', current: true, path: '/data/pupitre/sidecar.log', entries: [] },
    {
      name: 'dev',
      current: false,
      path: '/data/pupitre-dev/sidecar.log',
      entries: [
        { at: '2026-10-14T21:18:40.000Z', kind: 'start', detail: 'pid 7' },
        { at: '2026-10-14T21:18:40.000Z', kind: 'unexplained', detail: 'arrêt sans trace avant ce démarrage' },
        { at: '2026-10-14T21:18:38.735Z', kind: 'stop', detail: 'SIGTERM' },
        { at: '2026-10-14T21:10:00.000Z', kind: 'stop', detail: 'éviction par une autre instance (POST /api/shutdown)' },
      ],
    },
  ],
}

test('liste les redémarrages de chaque instance avec leur cause', async () => {
  render(createElement(SidecarJournalCard, { load: async () => journal }))

  const dev = await screen.findByRole('region', { name: 'Instance dev' })
  const rows = [...dev.querySelectorAll('li')].map((row) => row.textContent)
  expect(rows).toHaveLength(4)
  expect(rows[1]).toContain('Arrêt sans trace')
  expect(rows[1]).toContain('SIGKILL, plantage natif ou machine éteinte')
  expect(rows[2]).toContain('signal SIGTERM')
  expect(rows[3]).toMatch(/éviction par une autre instance$/)
  expect(screen.getByRole('region', { name: 'Instance stable' }).textContent).toContain('cette instance')
  expect(screen.getByRole('region', { name: 'Instance stable' }).textContent).toContain('Aucun redémarrage journalisé')
})

test('une réponse illisible affiche une erreur au lieu de casser les réglages', async () => {
  render(createElement(SidecarJournalCard, { load: async () => ({}) as SidecarJournal }))
  expect((await screen.findByRole('alert')).textContent).toBe('Journal illisible.')
})
