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

test('ne porte que les projets : les destinations vivent dans la barre de titre', async () => {
  globalThis.fetch = mock(async () => Response.json([
    { id: 'p1', name: 'affilae mono', path: '/tmp/a', pinned: false },
  ])) as typeof fetch
  render(createElement(Rail, {
    selectedProject: null,
    projectListVersion: 0,
    workspaceView: 'conversations',
    onProjectSelect: () => {},
    onProjectCreated: () => {},
  }))

  expect(await screen.findByRole('button', { name: 'affilae mono' })).toBeTruthy()
  for (const label of ['Conversations', 'Projet', 'Activité', 'Contexte', 'Automatisations', 'Utilisation', 'Réglages', 'Aide']) {
    expect(screen.queryByRole('button', { name: label })).toBeNull()
  }
})
