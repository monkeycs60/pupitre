import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

if (typeof document === 'undefined') GlobalRegistrator.register()

mock.module('@tauri-apps/plugin-opener', () => ({
  openUrl: async () => {},
  openPath: async () => {},
  revealItemInDir: async () => {},
}))

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { ProjectLiveLaunches } = await import('./ProjectLaunch')
const defaultFetch = globalThis.fetch

afterEach(() => {
  cleanup()
  globalThis.fetch = defaultFetch
})

const project = { id: 'p1', name: 'coworker-malin', path: '/code/cm' } as never

test('résume les serveurs, puis détaille une commande de Pupitre avec relance, logs et arrêt', async () => {
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
  const summary = await screen.findByRole('button', { name: /2 serveurs/ })
  expect(summary.getAttribute('aria-expanded')).toBe('false')
  expect(summary.textContent).toContain('sur 1 branche')
  fireEvent.click(summary)
  const front = screen.getByRole('link', { name: /localhost:5174\/app/ })
  expect(front.getAttribute('href')).toBe('http://localhost:5174/app/')
  expect(front.className).not.toContain('is-pending')
  expect(screen.getByRole('link', { name: /localhost:3000/ }).className).toContain('is-pending')
  expect(screen.queryByText('Tests')).toBeNull()
  expect(screen.getByText('lancé par Pupitre')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Relancer Développement' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Logs de Développement' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Arrêter Développement' })).toBeTruthy()
})

test('ne montre rien quand aucune commande ne tourne', async () => {
  const fetchMock = mock(async () => Response.json([]))
  globalThis.fetch = fetchMock as unknown as typeof fetch
  const { container } = render(<ProjectLiveLaunches project={{ ...(project as object), id: 'p2' } as never} />)
  await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  expect(container.querySelector('.servers-block')).toBeNull()
})

test('range les serveurs lancés ailleurs par branche, sans doubler ceux de Pupitre', async () => {
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    if (String(input).includes('/api/applications')) {
      const base = { projectName: 'coworker-malin', workspace: 'app', branch: 'master', cwd: '/code/cm', process: 'node' }
      return Response.json([
        { ...base, id: '1:5174', name: '@cm/app', projectId: 'p3', pid: 1, port: 5174, url: 'http://localhost:5174' },
        { ...base, id: '2:3000', name: '@cm/api', projectId: 'p3', pid: 2, port: 3000, url: 'http://localhost:3000' },
        { ...base, id: '3:8080', name: 'autre', projectId: 'other', pid: 3, port: 8080, url: 'http://localhost:8080' },
        { ...base, id: '4:4219', name: 'affilae-api', branch: 'feature/TECH-1', projectId: 'p3', pid: 4, port: 4219, url: 'http://localhost:4219', ticket: { key: 'TECH-1', title: 'Match AI', url: 'https://app.clickup.com/t/1' } },
        { ...base, id: '5:8106', name: 'reactor', branch: 'feature/TECH-1', projectId: 'p3', pid: 5, port: 8106, url: 'http://localhost:8106', ticket: { key: 'TECH-1', title: 'Match AI', url: 'https://app.clickup.com/t/1' } },
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
  const summary = await screen.findByRole('button', { name: /4 serveurs/ })
  expect(summary.textContent).toContain('sur 3 branches')
  fireEvent.click(summary)
  expect(screen.getAllByRole('link', { name: /localhost:5174/ })).toHaveLength(1)
  expect(screen.queryByRole('link', { name: /8080/ })).toBeNull()
  const rows = [...document.querySelectorAll('.servers-row')]
  expect(rows).toHaveLength(3)
  expect(rows[1]!.querySelector('.servers-row-who strong')!.textContent).toBe('master')
  expect(rows[2]!.querySelector('.servers-row-who')!.textContent).toContain('TECH-1')
  expect(rows[2]!.querySelector('.servers-row-who')!.textContent).toContain('Match AI')
  expect(rows[2]!.querySelectorAll('.port-chip')).toHaveLength(2)
  expect(rows[2]!.textContent).toContain('api')
  expect(rows[2]!.textContent).toContain('4219')
})
