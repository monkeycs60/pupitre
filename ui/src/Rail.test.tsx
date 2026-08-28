import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, render, screen } = await import('@testing-library/react')
const { Rail } = await import('./Rail')
const defaultFetch = globalThis.fetch

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

  expect(await screen.findByText('Ctrl Alt C')).toBeTruthy()
  expect(screen.getByText('Ctrl Alt F')).toBeTruthy()
  expect(screen.getByText('Ctrl Alt T')).toBeTruthy()
  expect(screen.getByText('Ctrl Alt D')).toBeTruthy()
  expect(screen.getByText('Ctrl Alt G')).toBeTruthy()
})
