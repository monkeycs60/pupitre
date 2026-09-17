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
    projectId: 'affilae-mono',
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
    {
      ...reactor,
      id: '45:5173',
      name: 'ui',
      projectId: 'pupitre',
      projectName: 'Pupitre',
      workspace: 'ui',
      branch: 'master',
      cwd: '/code/pupitre/ui',
      process: 'node',
      pid: 45,
      port: 5173,
      url: 'http://localhost:5173',
    },
  ])) as typeof fetch

  render(<ApplicationsView />)

  const pairedGroup = await screen.findByRole('rowgroup', { name: 'Affilae — tech/25169' })
  expect(within(pairedGroup).getByText('reactor')).toBeTruthy()
  expect(within(pairedGroup).getByText('affilae-api')).toBeTruthy()
  const affilae = screen.getByRole('region', { name: 'Affilae' })
  const pupitre = screen.getByRole('region', { name: 'Pupitre' })
  expect(within(affilae).getByText('2 branches')).toBeTruthy()
  expect(within(affilae).getByText('3 applications')).toBeTruthy()
  expect(within(pupitre).getByText('1 branche')).toBeTruthy()
  expect(screen.getAllByRole('rowgroup')).toHaveLength(3)
  expect(affilae.querySelector('[data-project-glyph]')?.getAttribute('data-project-glyph'))
    .not.toBe(pupitre.querySelector('[data-project-glyph]')?.getAttribute('data-project-glyph'))
  expect(screen.getByRole('link', { name: 'Ouvrir reactor sur le port 8098' }).getAttribute('href')).toBe('http://localhost:8098')
})
