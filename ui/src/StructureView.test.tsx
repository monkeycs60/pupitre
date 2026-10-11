import { afterEach, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { StructureView } from './StructureView'
import type { Conversation, Project } from './types'

const defaultFetch = globalThis.fetch

afterEach(() => {
  cleanup()
  globalThis.fetch = defaultFetch
})

function mockRepository() {
  const source = { path: '/repo', repositoryPath: '/repo', repositoryLabel: 'acme/repo', branch: 'feature/X-1234', head: 'abc', detached: false, main: false, conversations: [], ref: null, updatedAt: null }
  globalThis.fetch = mock(async (input) => {
    const url = String(input)
    if (url.includes('/code/sources')) return Response.json([source])
    if (url.includes('/code/files')) {
      return Response.json({
        paths: ['src/api/users.ts', 'src/api/orders.ts', 'src/ui/Button.tsx', 'docs/guide.md', 'src/helpers/format.ts', 'PLAN.md'],
        submodules: [],
        dirty: [],
        truncated: false,
      })
    }
    return Response.json({
      base: 'develop',
      from: 'develop',
      head: 'abc',
      filesTruncated: false,
      files: [
        { path: 'src/api/users.ts', previousPath: null, status: 'M', added: 4, removed: 2 },
        { path: 'src/helpers/format.ts', previousPath: null, status: 'A', added: 30, removed: 0 },
        { path: 'PLAN.md', previousPath: null, status: 'A', added: 12, removed: 0 },
      ],
    })
  }) as typeof fetch
}

function renderView(onOpenFile = mock(() => {})) {
  render(createElement(StructureView, {
    project: { id: 'p1', name: 'repo' } as Project,
    conversation: null as Conversation | null,
    onOpenFile,
  }))
  return onOpenFile
}

test('montre les fichiers touchés à leur place dans l’arborescence, les voisins repliés', async () => {
  mockRepository()
  renderView()

  await waitFor(() => expect(screen.getByText('users.ts')).toBeTruthy())

  expect(screen.getByRole('button', { name: /^src\// }).textContent).toContain('2 sur 4')
  expect(screen.getByText('format.ts')).toBeTruthy()
  expect(screen.queryByText('orders.ts')).toBeNull()
  expect(screen.queryByText('Button.tsx')).toBeNull()

  const api = screen.getByRole('button', { name: /^api\// }).closest('li')!
  fireEvent.click(api.querySelector('.is-quiet-toggle')!)
  expect(screen.getByText('orders.ts')).toBeTruthy()
})

test('étiquette un nouveau dossier et un fichier créé à la racine', async () => {
  mockRepository()
  renderView()

  await waitFor(() => expect(screen.getByText('users.ts')).toBeTruthy())

  expect(screen.getByRole('button', { name: /helpers\/.*nouveau dossier/ })).toBeTruthy()
  expect(screen.getByRole('button', { name: /PLAN\.md.*à vérifier/ })).toBeTruthy()
  expect(screen.getByRole('button', { name: /users\.ts/ }).textContent).not.toContain('à vérifier')
})

test('un signal estompe tout ce qui ne le concerne pas', async () => {
  mockRepository()
  renderView()

  await waitFor(() => expect(screen.getByText('users.ts')).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: /Nouveaux dossiers/ }))

  expect(screen.getByRole('button', { name: /users\.ts/ }).className).toContain('is-dimmed')
  expect(screen.getByRole('button', { name: /format\.ts/ }).className).not.toContain('is-dimmed')
  expect(screen.getByRole('button', { name: /^src\// }).className).not.toContain('is-dimmed')
})

test('un clic sur un fichier l’ouvre dans Code', async () => {
  mockRepository()
  const onOpenFile = renderView()

  await waitFor(() => expect(screen.getByText('users.ts')).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: /users\.ts/ }))

  expect(onOpenFile).toHaveBeenCalledWith('/repo', 'src/api/users.ts')
})
