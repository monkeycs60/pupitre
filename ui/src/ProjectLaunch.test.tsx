import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

if (typeof document === 'undefined') GlobalRegistrator.register()

mock.module('@tauri-apps/plugin-opener', () => ({
  openUrl: async () => {},
  openPath: async () => {},
  revealItemInDir: async () => {},
}))

const { cleanup, render, screen, waitFor } = await import('@testing-library/react')
const { ProjectLiveLaunches } = await import('./ProjectLaunch')
const defaultFetch = globalThis.fetch

afterEach(() => {
  cleanup()
  globalThis.fetch = defaultFetch
})

const project = { id: 'p1', name: 'coworker-malin', path: '/code/cm' } as never

test('affiche les adresses d’une commande en cours, le front en premier et en vert', async () => {
  globalThis.fetch = mock(async () => Response.json([
    {
      id: 'dev', project_id: 'p1', name: 'Développement', command: 'bun run dev', cwd_relative: '.', port: null, kind: 'run', running: true,
      url: 'http://localhost:5174/app/',
      urls: [
        { url: 'http://localhost:5174/app/', port: 5174, front: true, live: true },
        { url: 'http://localhost:3000', port: 3000, front: false, live: false },
      ],
    },
    { id: 'test', project_id: 'p1', name: 'Tests', command: 'bun test', cwd_relative: '.', port: null, kind: 'run', running: false, urls: [] },
  ])) as unknown as typeof fetch
  render(<ProjectLiveLaunches project={project} />)
  const front = await screen.findByRole('link', { name: /localhost:5174\/app/ })
  expect(front.getAttribute('href')).toBe('http://localhost:5174/app/')
  expect(front.className).toContain('is-live')
  expect(front.className).toContain('is-primary')
  expect(screen.getByRole('link', { name: /localhost:3000/ }).className).toContain('is-pending')
  expect(screen.queryByText('Tests')).toBeNull()
  expect(screen.getByRole('button', { name: 'Arrêter Développement' })).toBeTruthy()
})

test('ne montre rien quand aucune commande ne tourne', async () => {
  const fetchMock = mock(async () => Response.json([]))
  globalThis.fetch = fetchMock as unknown as typeof fetch
  const { container } = render(<ProjectLiveLaunches project={{ ...(project as object), id: 'p2' } as never} />)
  await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  expect(container.querySelector('.launch-live-strip')).toBeNull()
})

test('montre en gris les serveurs du projet lancés ailleurs, sans doubler ceux de Pupitre', async () => {
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    if (String(input).includes('/api/applications')) {
      const base = { projectName: 'coworker-malin', workspace: 'app', branch: 'master', cwd: '/code/cm', process: 'node' }
      return Response.json([
        { ...base, id: '1:5174', name: '@cm/app', projectId: 'p3', pid: 1, port: 5174, url: 'http://localhost:5174' },
        { ...base, id: '2:3000', name: '@cm/api', projectId: 'p3', pid: 2, port: 3000, url: 'http://localhost:3000' },
        { ...base, id: '3:8080', name: 'autre', projectId: 'other', pid: 3, port: 8080, url: 'http://localhost:8080' },
      ])
    }
    return Response.json([
      {
        id: 'dev', project_id: 'p3', name: 'Développement', command: 'bun run dev', cwd_relative: '.', port: null, kind: 'run', running: true,
        urls: [{ url: 'http://localhost:5174/app/', port: 5174, front: true, live: true }],
      },
    ])
  }) as unknown as typeof fetch
  render(<ProjectLiveLaunches project={{ ...(project as object), id: 'p3' } as never} />)
  const api = await screen.findByRole('link', { name: /localhost:3000/ })
  expect(api.className).toContain('is-external')
  expect(screen.getByText('Lancé ailleurs')).toBeTruthy()
  expect(screen.getAllByRole('link', { name: /localhost:5174/ })).toHaveLength(1)
  expect(screen.queryByRole('link', { name: /8080/ })).toBeNull()
})
