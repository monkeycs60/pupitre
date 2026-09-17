import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

if (typeof document === 'undefined') GlobalRegistrator.register()

mock.module('@tauri-apps/plugin-opener', () => ({
  openUrl: async () => {},
  openPath: async () => {},
  revealItemInDir: async () => {},
}))

const { cleanup, render, screen } = await import('@testing-library/react')
const { ApplicationsView } = await import('./ApplicationsView')
const defaultFetch = globalThis.fetch

afterEach(() => {
  cleanup()
  globalThis.fetch = defaultFetch
})

test('affiche le nom, le worktree, le port et un lien localhost par application', async () => {
  globalThis.fetch = mock(async () => Response.json([{
    id: '42:8098',
    name: 'reactor',
    projectId: 'affilae',
    projectName: 'Affilae',
    workspace: 'reactor-tech25169',
    branch: 'tech/25169',
    cwd: '/code/affilae/apps/reactor-tech25169',
    process: 'node',
    pid: 42,
    port: 8098,
    url: 'http://localhost:8098',
  }])) as typeof fetch

  render(<ApplicationsView />)

  expect(await screen.findByText('reactor')).toBeTruthy()
  expect(screen.getByText('Affilae')).toBeTruthy()
  expect(screen.getByText('tech/25169')).toBeTruthy()
  expect(screen.getByText('8098')).toBeTruthy()
  expect(screen.getByRole('link', { name: 'Ouvrir reactor sur le port 8098' }).getAttribute('href')).toBe('http://localhost:8098')
})
