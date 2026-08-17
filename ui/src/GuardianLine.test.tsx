import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { Conversation, Project, Review } from './types'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { GuardianLine } = await import('./GuardianLine')
const defaultFetch = globalThis.fetch
const defaultConfirm = window.confirm

afterEach(() => {
  cleanup()
  globalThis.fetch = defaultFetch
  window.confirm = defaultConfirm
})

const project: Project = {
  id: 'project-1',
  name: 'Pupitre',
  path: '/tmp/pupitre',
  permission_mode: 'default',
  filesystem_scope: 'project-and-ai-roots',
  pinned: false,
  created_at: '2026-08-17T00:00:00.000Z',
  default_preset_id: null,
  default_review_preset_id: null,
  default_correction_preset_id: null,
  auto_rescan: false,
}

const conversation: Conversation = {
  id: 'conversation-1',
  project_id: project.id,
  title: 'Correction',
  summary: '',
  provider: 'codex',
  model: 'gpt-5.6-sol',
  effort: 'high',
  speed: 'standard',
  permission_mode: 'default',
  orchestrator: true,
  subagent_preset_id: null,
  subagent_effort: null,
  created_at: '2026-08-17T00:00:00.000Z',
  updated_at: '2026-08-17T00:00:00.000Z',
}

const review: Review = {
  id: 'review-1',
  project_id: project.id,
  conversation_id: conversation.id,
  git_ref_base: 'base',
  git_ref_head: 'head',
  status: 'done',
  review_provider: 'codex',
  review_model: 'gpt-5.6-sol',
  review_effort: 'high',
  review_speed: 'standard',
  diff_text: 'diff',
  error: null,
  created_at: '2026-08-17T00:00:00.000Z',
  updated_at: '2026-08-17T00:00:00.000Z',
  code_provider: 'codex',
  scope: 'worktree',
  parent_review_id: null,
  flags: Array.from({ length: 2 }, (_, index) => ({
    id: `flag-${index + 1}`,
    review_id: 'review-1',
    file: `src/file-${index + 1}.ts`,
    line_start: 1,
    line_end: 1,
    severity: 'red',
    category: 'bug',
    message: 'Erreur',
    status: 'open',
    code_provider: 'codex',
  })),
}

test('un diff modifié depuis la relecture prime sur le rouge ouvert', async () => {
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/reviews')) return Response.json([review])
    if (url.endsWith('/diff')) return Response.json({ diff: 'diff modifié', files: [] })
    return Response.json({ error: 'route inattendue' }, { status: 404 })
  }) as typeof fetch

  render(createElement(GuardianLine, {
    conversation,
    project,
    reviewStatus: null,
    onOpenCode: () => undefined,
    onRelire: () => undefined,
  }))

  await screen.findByText('modifié depuis la relecture — à relire')
  const line = screen.getByRole('group', { name: 'Gardien' })
  expect(line.className).toContain('is-stale')
  expect(line.className).not.toContain('is-block')
  // La correction reste offerte : le verdict est caduc, pas les erreurs déjà trouvées.
  expect(screen.getByRole('button', { name: 'Corriger les 2 erreurs' })).toBeTruthy()
})

test('propose et lance directement toutes les corrections ouvertes', async () => {
  const requests: Array<{ url: string, init?: RequestInit }> = []
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    requests.push({ url, init })
    if (url.endsWith('/reviews')) return Response.json([review])
    if (url.endsWith('/diff')) return Response.json({ diff: 'diff', files: [] })
    if (url.endsWith('/dispatch-all')) return Response.json({ dispatched: 2 }, { status: 202 })
    return Response.json({ error: 'route inattendue' }, { status: 404 })
  }) as typeof fetch
  window.confirm = mock(() => true)

  render(createElement(GuardianLine, {
    conversation,
    project,
    reviewStatus: null,
    onOpenCode: () => undefined,
    onRelire: () => undefined,
  }))

  const button = await screen.findByRole('button', { name: 'Corriger les 2 erreurs' })
  fireEvent.click(button)

  await waitFor(() => expect(requests.some(({ url }) => url.endsWith('/reviews/review-1/dispatch-all'))).toBe(true))
  const dispatch = requests.find(({ url }) => url.endsWith('/reviews/review-1/dispatch-all'))
  expect(dispatch?.init?.method).toBe('POST')
  expect(JSON.parse(String(dispatch?.init?.body))).toEqual({ severities: ['red', 'orange', 'grey'] })
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Corriger les 2 erreurs' })).toBeNull())
})
