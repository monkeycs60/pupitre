import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'

if (typeof document === 'undefined') GlobalRegistrator.register()

mock.module('./AppSettingsView', () => ({ AppSettingsView: () => createElement('div', null, 'réglages généraux') }))
mock.module('./HelpView', () => ({ HelpView: () => createElement('div', null, 'contenu aide') }))

const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const { SettingsShell } = await import('./SettingsShell')

afterEach(cleanup)

test('ouvre Général par défaut et bascule vers Aide depuis la sidebar', () => {
  render(createElement(SettingsShell, { instance: null }))
  expect(screen.getByText('réglages généraux')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Aide' }))
  expect(screen.getByText('contenu aide')).toBeTruthy()
  expect(screen.queryByText('réglages généraux')).toBeNull()
})

test('ouvre directement Aide quand une page est demandée', () => {
  render(createElement(SettingsShell, { instance: null, helpSlug: 'conversations' }))
  expect(screen.getByText('contenu aide')).toBeTruthy()
})
