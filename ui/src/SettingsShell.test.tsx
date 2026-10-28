import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'

if (typeof document === 'undefined') GlobalRegistrator.register()

mock.module('./HelpView', () => ({ HelpView: () => createElement('div', null, 'contenu aide') }))

const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const { SettingsShell } = await import('./SettingsShell')

const defaultFetch = globalThis.fetch
afterEach(() => {
  cleanup()
  globalThis.fetch = defaultFetch
})

test('ouvre Général par défaut et bascule vers Aide depuis la sidebar', async () => {
  globalThis.fetch = mock(async () => Response.json({})) as unknown as typeof fetch
  render(createElement(SettingsShell, { instance: null }))
  expect(await screen.findByText('Paramètres globaux')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Aide' }))
  expect(screen.getByText('contenu aide')).toBeTruthy()
  expect(screen.queryByText('Paramètres globaux')).toBeNull()
})

test('ouvre directement Aide quand une page est demandée', () => {
  render(createElement(SettingsShell, { instance: null, helpSlug: 'conversations' }))
  expect(screen.getByText('contenu aide')).toBeTruthy()
})
