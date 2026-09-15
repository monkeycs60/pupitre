import { expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import { groupEvents } from './groupEvents'
import type { AppEvent } from './types'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, render, screen } = await import('@testing-library/react')
const { EventView } = await import('./EventView')

const running: AppEvent = { type: 'status', state: 'running' }

function footerOf(events: AppEvent[]) {
  const footer = groupEvents(events).findLast((block) => block.kind === 'turn-footer')
  if (footer?.kind !== 'turn-footer') throw new Error('pied de tour absent')
  return footer
}

function renderFooter(events: AppEvent[]) {
  return render(createElement(EventView, {
    block: footerOf(events),
    onImageOpen: () => {},
    onImageLoad: () => {},
  }))
}

test('la réflexion en cours affiche son aperçu et la phase du provider', () => {
  renderFooter([
    { type: 'user-message', text: 'go', images: [] },
    running,
    { type: 'turn-phase', phase: 'waiting_permission' },
    { type: 'reasoning-delta', text: 'Je lis   le\nfichier ' },
    { type: 'reasoning-delta', text: 'package.json' },
  ])

  expect(screen.getByRole('status').textContent).toContain('réfléchit…')
  expect(screen.getByRole('status').textContent).toContain('attente d’autorisation')
  expect(screen.getByTitle('Aperçu de la réflexion en cours').textContent).toBe('Je lis le fichier package.json')
  cleanup()
})

test('le texte ou un outil remplace l’aperçu de réflexion', () => {
  renderFooter([running, { type: 'reasoning-delta', text: 'hmm' }, { type: 'text-delta', text: 'Bon' }])
  expect(screen.getByRole('status').textContent).toContain('écrit…')
  expect(screen.queryByTitle('Aperçu de la réflexion en cours')).toBeNull()
  cleanup()

  renderFooter([running, { type: 'reasoning-delta', text: 'hmm' }, { type: 'tool-start', toolId: 't', toolName: 'bash', input: {} }])
  expect(screen.getByRole('status').textContent).toContain('agit…')
  cleanup()
})

test('une nouvelle réflexion repart de zéro après une autre activité', () => {
  const footer = footerOf([
    running,
    { type: 'reasoning-delta', text: 'ancienne' },
    { type: 'text-delta', text: 'x' },
    { type: 'reasoning-delta', text: 'nouvelle' },
  ])
  expect(footer.reasoningSegments).toEqual(['ancienne', 'nouvelle'])
})

test('une fois le tour terminé, la réflexion complète reste repliée sous le tour', () => {
  const { container } = renderFooter([
    running,
    { type: 'reasoning-delta', text: 'Je lis ' },
    { type: 'reasoning-delta', text: 'le fichier.' },
    { type: 'tool-start', toolId: 't', toolName: 'bash', input: {} },
    { type: 'reasoning-delta', text: 'Puis je conclus.' },
    { type: 'status', state: 'done' },
  ])
  expect(screen.queryByTitle('Aperçu de la réflexion en cours')).toBeNull()
  const details = container.querySelector('details.turn-reasoning') as HTMLDetailsElement
  expect(details.open).toBe(false)
  expect([...details.querySelectorAll('p')].map((p) => p.textContent)).toEqual(['Je lis le fichier.', 'Puis je conclus.'])
  cleanup()
})
