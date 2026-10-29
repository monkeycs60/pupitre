import { afterEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, render, screen } = await import('@testing-library/react')
const { Titlebar } = await import('./Titlebar')

afterEach(cleanup)

const health = (instance: 'dev' | 'stable', staleSources = 0) => ({
  ok: true,
  instance,
  port: instance === 'dev' ? 4821 : 4820,
  pid: 1,
  appPid: 1,
  startedAt: '2026-10-28T10:00:00.000Z',
  build: { sha: 'abc1234', dirty: false, source: 'git' as const },
  staleSources,
})

test('rend les destinations en icônes nommées et marque la vue courante', () => {
  render(createElement(Titlebar, {
    workspaceView: 'settings' as const,
    destinations: [
      { icon: 'chart' as const, label: 'Rapport', view: 'activity-report' as const, onClick: () => {} },
      { icon: 'settings' as const, label: 'Réglages', view: 'settings' as const, onClick: () => {} },
    ],
  }))

  const buttons = [...document.querySelectorAll('.titlebar-icon-button')]
  expect(buttons).toHaveLength(2)
  expect(buttons.filter((button) => button.classList.contains('is-active'))).toHaveLength(1)
  expect(screen.getByRole('button', { name: 'Réglages' }).getAttribute('aria-current')).toBe('page')
  expect(screen.getByRole('button', { name: 'Rapport' }).getAttribute('aria-current')).toBeNull()
})

test('montre le badge d’instance en dev et le cache en stable tant que les sources sont à jour', () => {
  const restart = async () => {}
  const { rerender } = render(createElement(Titlebar, { instance: health('dev'), onRestart: restart }))
  expect(document.querySelector('.titlebar-instance')?.textContent).toContain('dev')

  rerender(createElement(Titlebar, { instance: health('stable'), onRestart: restart }))
  expect(document.querySelector('.titlebar-instance')).toBeNull()

  rerender(createElement(Titlebar, { instance: health('stable', 2), onRestart: restart }))
  expect(document.querySelector('.titlebar-instance')).not.toBeNull()
})

test('le bouton de navigation mobile porte le compte des réponses à lire, plafonné à 9+', () => {
  const toggle = () => {}
  const { rerender } = render(createElement(Titlebar, { onNavigationToggle: toggle, navigationBadge: 3 }))
  const button = screen.getByRole('button', { name: 'Projets et conversations' })
  expect(button.querySelector('.mobile-navigation-badge')?.textContent).toBe('3')

  rerender(createElement(Titlebar, { onNavigationToggle: toggle, navigationBadge: 12 }))
  expect(button.querySelector('.mobile-navigation-badge')?.textContent).toBe('9+')

  rerender(createElement(Titlebar, { onNavigationToggle: toggle, navigationBadge: 12, navigationOpen: true }))
  expect(button.querySelector('.mobile-navigation-badge')).toBeNull()

  rerender(createElement(Titlebar, { onNavigationToggle: toggle, navigationBadge: 0 }))
  expect(button.querySelector('.mobile-navigation-badge')).toBeNull()
})
