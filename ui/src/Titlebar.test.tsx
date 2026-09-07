import { afterEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, render, screen } = await import('@testing-library/react')
const { Titlebar } = await import('./Titlebar')

afterEach(cleanup)

test('affiche les destinations globales et marque la vue courante', () => {
  render(createElement(Titlebar, {
    crumbs: ['affilae-mono'],
    workspaceView: 'attention' as const,
    hasProject: true,
    destinations: [
      { name: 'conversations' as const, label: 'Conversations', view: 'conversations' as const, onClick: () => {} },
      { name: 'attention' as const, label: 'Activité', view: 'attention' as const, onClick: () => {}, badge: 3 },
      { name: 'settings' as const, label: 'Réglages', view: 'settings' as const, onClick: () => {} },
    ],
  }))

  const buttons = [...document.querySelectorAll('.titlebar-nav-button')]
  expect(buttons).toHaveLength(3)
  expect(buttons.filter((button) => button.classList.contains('is-active'))).toHaveLength(1)
  expect(screen.getByRole('button', { name: 'Activité, 3 à lire' })).toBeTruthy()
  expect(document.querySelector('.titlebar-nav-badge')?.textContent).toBe('3')
})

test('désactive les destinations qui exigent un projet quand il n’y en a pas', () => {
  render(createElement(Titlebar, {
    hasProject: false,
    destinations: [
      { name: 'dashboard' as const, label: 'Projet', view: 'dashboard' as const, onClick: () => {}, needsProject: true },
    ],
  }))

  expect(screen.getByRole('button', { name: 'Projet' }).hasAttribute('disabled')).toBe(true)
})
