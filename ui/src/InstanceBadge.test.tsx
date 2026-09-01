import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const { InstanceBadge } = await import('./InstanceBadge')

afterEach(cleanup)

const stable = {
  ok: true as const,
  instance: 'stable' as const,
  port: 4820,
  pid: 10,
  appPid: 9,
  startedAt: '2026-09-01T09:12:00.000Z',
  build: { sha: 'a3c164b', dirty: false, source: 'build' as const },
  staleSources: 0,
}

test('rend la stable comme une information sans action', () => {
  render(createElement(InstanceBadge, { health: stable, onRestart: async () => {} }))
  expect(screen.getByText('stable · a3c164b').tagName).toBe('SPAN')
  expect(screen.queryByRole('button')).toBeNull()
})

test('rend la dev modifiée comme un bouton', () => {
  render(createElement(InstanceBadge, {
    health: { ...stable, instance: 'dev', port: 4821, build: { ...stable.build, dirty: true, source: 'git' } },
    onRestart: async () => {},
  }))
  expect(screen.getByRole('button', { name: 'dev · a3c164b*' })).toBeTruthy()
})

test('signale les sources périmées et redémarre au clic', () => {
  const onRestart = mock(async () => {})
  render(createElement(InstanceBadge, {
    health: {
      ...stable,
      instance: 'dev',
      port: 4821,
      staleSources: 3,
      build: { ...stable.build, dirty: true, source: 'git' },
    },
    onRestart,
  }))
  const button = screen.getByRole('button', { name: 'dev · a3c164b* · périmé (3)' })
  expect(button.classList.contains('is-stale')).toBe(true)
  fireEvent.click(button)
  expect(onRestart).toHaveBeenCalledTimes(1)
})
