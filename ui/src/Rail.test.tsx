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
  expect(screen.queryByText('Ctrl Maj G')).toBeNull()
  expect(screen.getByRole('button', { name: 'Inbox' })).toBeTruthy()
  expect(railCss).toMatch(/\.rail-nav-label\s*>\s*span\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?overflow:\s*hidden;/)
  expect(railCss).toMatch(/\.rail-nav-shortcut\s*\{[\s\S]*?flex:\s*none;/)
})

test('place Claude Design dans le groupe de travail avec une icône palette', async () => {
  globalThis.fetch = mock(async () => Response.json([])) as typeof fetch
  const hadTauri = '__TAURI__' in window
  const previousTauri = window.__TAURI__
  window.__TAURI__ = {} as typeof window.__TAURI__
  try {
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
      onAttentionSelect: () => {},
      onMemorySelect: () => {},
      onHelpSelect: () => {},
      onProgressSelect: () => {},
      onSettingsSelect: () => {},
    }))

    const buttons = await screen.findAllByRole('button')
    const labels = buttons.map((button) => button.getAttribute('aria-label') ?? button.textContent)
    expect(labels.indexOf('Claude Design')).toBeGreaterThan(labels.indexOf('Tableau de bord'))
    expect(labels.indexOf('Claude Design')).toBeLessThan(labels.indexOf('Inbox'))
    expect(screen.getByRole('button', { name: 'Claude Design' }).querySelectorAll('circle')).toHaveLength(3)
  } finally {
    if (hadTauri) window.__TAURI__ = previousTauri
    else Reflect.deleteProperty(window, '__TAURI__')
  }
})
