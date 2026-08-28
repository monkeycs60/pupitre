import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import { readFileSync } from 'node:fs'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, render, screen } = await import('@testing-library/react')
const { Rail } = await import('./Rail')
const defaultFetch = globalThis.fetch
const railCss = readFileSync(new URL('./styles/shell.css', import.meta.url), 'utf8')

afterEach(() => {
  cleanup()
  globalThis.fetch = defaultFetch
})

test('affiche le raccourci à côté de chaque destination concernée', async () => {
  globalThis.fetch = mock(async () => Response.json([])) as typeof fetch
  render(createElement(Rail, {
    selectedProject: null,
    projectListVersion: 0,
    workspaceView: 'conversations',
    onProjectSelect: () => {},
    onProjectCreated: () => {},
    onConversationsSelect: () => {},
    onDashboardSelect: () => {},
    onDocumentsSelect: () => {},
    onDesignSelect: () => {},
    onCostsSelect: () => {},
    onLibrarySelect: () => {},
    onRoutinesSelect: () => {},
    onFleetSelect: () => {},
    onMemorySelect: () => {},
    onHelpSelect: () => {},
    onProgressSelect: () => {},
    onSettingsSelect: () => {},
  }))

  expect(await screen.findByText('Ctrl Maj C')).toBeTruthy()
  expect(screen.getByText('Ctrl Maj F')).toBeTruthy()
  expect(screen.getByText('Ctrl Maj T')).toBeTruthy()
  expect(screen.getByText('Ctrl Maj D')).toBeTruthy()
  expect(screen.getByText('Ctrl Maj G')).toBeTruthy()
  expect(railCss).toMatch(/\.rail-nav-label\s*>\s*span\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?overflow:\s*hidden;/)
  expect(railCss).toMatch(/\.rail-nav-shortcut\s*\{[\s\S]*?flex:\s*none;/)
})
