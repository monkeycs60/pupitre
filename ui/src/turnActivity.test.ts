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

test('la réflexion en cours affiche l’activité et la phase du provider', () => {
  renderFooter([
    { type: 'user-message', text: 'go', images: [] },
    running,
    { type: 'turn-phase', phase: 'waiting_permission' },
    { type: 'reasoning-delta', text: 'Je lis le fichier' },
  ])

  expect(screen.getByRole('status').textContent).toContain('réfléchit…')
  expect(screen.getByRole('status').textContent).toContain('attente d’autorisation')
  cleanup()
})

test('le texte ou un outil prend le relais de la réflexion dans le pied', () => {
  renderFooter([running, { type: 'reasoning-delta', text: 'hmm' }, { type: 'text-delta', text: 'Bon' }])
  expect(screen.getByRole('status').textContent).toContain('écrit…')
  cleanup()

  renderFooter([running, { type: 'reasoning-delta', text: 'hmm' }, { type: 'tool-start', toolId: 't', toolName: 'bash', input: {} }])
  expect(screen.getByRole('status').textContent).toContain('agit…')
  cleanup()
})

test('chaque réflexion prend sa place dans le fil, entre les actions qui l’entourent', () => {
  const blocks = groupEvents([
    running,
    { type: 'reasoning-delta', text: 'Je lis ' },
    { type: 'reasoning-delta', text: 'le fichier.' },
    { type: 'tool-start', toolId: 't', toolName: 'bash', input: {} },
    { type: 'reasoning-delta', text: 'Puis je conclus.' },
  ])
  expect(blocks.filter((block) => block.kind !== 'turn-footer').map((block) => block.kind === 'reasoning' ? block.text : block.kind))
    .toEqual(['Je lis le fichier.', 'tool', 'Puis je conclus.'])
})

test('la réflexion en cours grandit en entier, puis se replie sur sa première phrase', async () => {
  const { EventStream } = await import('./EventStream')
  const events: AppEvent[] = [
    { type: 'user-message', text: 'go', images: [] },
    running,
    { type: 'reasoning-delta', text: '**Inspecting config**\n\nJe lis le fichier. ' },
    { type: 'reasoning-delta', text: 'Puis je regarde le thème.' },
  ]
  const props = { onImageOpen: () => {}, onImageLoad: () => {} }
  const { container, rerender } = render(createElement(EventStream, { ...props, blocks: groupEvents(events) }))

  expect(container.querySelector('.reasoning.is-live .reasoning-body')?.textContent)
    .toBe('Inspecting config\n\nJe lis le fichier. Puis je regarde le thème.')

  rerender(createElement(EventStream, {
    ...props,
    blocks: groupEvents([...events, { type: 'tool-start', toolId: 't', toolName: 'Read', input: { file_path: '/a.ts' } }]),
  }))
  expect(container.querySelector('.reasoning-body')).toBeNull()
  expect(container.querySelector('.reasoning-title')?.textContent).toBe('Inspecting config')
  cleanup()
})
