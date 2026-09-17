import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

if (typeof document === 'undefined') GlobalRegistrator.register()

mock.module('@tauri-apps/plugin-opener', () => ({
  openUrl: async () => {},
  openPath: async () => {},
  revealItemInDir: async () => {},
}))

const { cleanup, render, screen, within } = await import('@testing-library/react')
const { ApplicationsView } = await import('./ApplicationsView')
const defaultFetch = globalThis.fetch

afterEach(() => {
  cleanup()
  globalThis.fetch = defaultFetch
})

test('regroupe le back et le front par projet et branche', async () => {
  const reactor = {
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
  }
  globalThis.fetch = mock(async () => Response.json([
    reactor,
    {
      ...reactor,
      id: '43:4218',
      name: 'affilae-api',
      workspace: 'hapigator-tech25169',
      cwd: '/code/affilae/apps/hapigator-tech25169',
      process: 'MainThread',
      pid: 43,
      port: 4218,
      url: 'http://localhost:4218',
    },
    {
      ...reactor,
      id: '44:4200',
      name: 'affilae-api',
      workspace: 'hapigator',
      branch: 'develop',
      cwd: '/code/affilae/apps/hapigator',
      process: 'MainThread',
      pid: 44,
      port: 4200,
      url: 'http://localhost:4200',
    },
  ])) as typeof fetch

  render(<ApplicationsView />)

  const pairedGroup = await screen.findByRole('rowgroup', { name: 'Affilae — tech/25169' })
  expect(within(pairedGroup).getByText('reactor')).toBeTruthy()
  expect(within(pairedGroup).getByText('affilae-api')).toBeTruthy()
  expect(within(pairedGroup).getByText('Affilae · 2 applications')).toBeTruthy()
  expect(screen.getAllByRole('rowgroup')).toHaveLength(2)
  expect(screen.getByRole('link', { name: 'Ouvrir reactor sur le port 8098' }).getAttribute('href')).toBe('http://localhost:8098')
})
