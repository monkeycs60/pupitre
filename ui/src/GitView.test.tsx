import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { Conversation, Project, Review } from './types'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { GitView } = await import('./GitView')
const defaultFetch = globalThis.fetch

afterEach(() => {
  cleanup()
  globalThis.fetch = defaultFetch
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
  title: 'Navigation',
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

const diff = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,2 @@',
  '-vieux',
  '+neuf',
  '+encore',
  '',
].join('\n')

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
  diff_text: diff,
  error: null,
  created_at: '2026-08-17T00:00:00.000Z',
  updated_at: '2026-08-17T00:00:00.000Z',
  code_provider: 'codex',
  scope: 'worktree',
  parent_review_id: null,
  flags: [1, 2].map((line) => ({
    id: `flag-${line}`,
    review_id: 'review-1',
    file: 'src/a.ts',
    line_start: line,
    line_end: line,
    severity: 'red',
    category: 'bug',
    message: `Erreur ${line}`,
    status: 'open',
    code_provider: 'codex',
  })),
}

function mockApi() {
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/git?') || url.endsWith('/git')) {
      return Response.json({ branch: 'master', commits: [], branchCommitShas: [], ahead: 0, behind: 0 })
    }
    if (url.endsWith('/diff')) return Response.json({ diff, files: ['src/a.ts'] })
    if (url.endsWith('/reviews')) return Response.json([review])
    return Response.json({ error: 'route inattendue' }, { status: 404 })
  }) as typeof fetch
}

function counter(): string {
  return document.querySelector('.changes-nav span')?.textContent ?? ''
}

async function renderChanges() {
  render(createElement(GitView, {
    project,
    conversation,
    focusedFlagId: null,
    reviewStatus: null,
    onConversationBack: () => undefined,
  }))
  await waitFor(() => expect(counter()).toBe('– / 2'))
}

test('j et k naviguent entre les signalements quand personne n’a le focus', async () => {
  mockApi()
  await renderChanges()

  fireEvent.keyDown(document.body, { key: 'j' })
  await waitFor(() => expect(counter()).toBe('1 / 2'))
  fireEvent.keyDown(document.body, { key: 'j' })
  await waitFor(() => expect(counter()).toBe('2 / 2'))
  fireEvent.keyDown(document.body, { key: 'k' })
  await waitFor(() => expect(counter()).toBe('1 / 2'))
})

test('j et k restent inertes dans une saisie ou sur un bouton', async () => {
  mockApi()
  await renderChanges()

  fireEvent.keyDown(screen.getByLabelText('Message du commit'), { key: 'j' })
  fireEvent.keyDown(screen.getByRole('button', { name: 'Signalement suivant' }), { key: 'j' })
  fireEvent.keyDown(document.body, { key: 'j', metaKey: true })
  expect(counter()).toBe('– / 2')
})

test('j et k ne bougent rien depuis un élément hors de la vue Code', async () => {
  mockApi()
  await renderChanges()
  const outside = document.createElement('div')
  outside.tabIndex = -1
  document.body.append(outside)

  fireEvent.keyDown(outside, { key: 'j' })
  expect(counter()).toBe('– / 2')
  outside.remove()
})

test('un dispatch partiel ne fait passer en correction que les signalements retenus', async () => {
  let reviewCalls = 0
  const dispatched: string[] = []
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/dispatch-all')) {
      dispatched.push(String(init?.body))
      return Response.json({ dispatched: 1, flagIds: ['flag-1'] }, { status: 202 })
    }
    if (url.includes('/git?') || url.endsWith('/git')) {
      return Response.json({ branch: 'master', commits: [], branchCommitShas: [], ahead: 0, behind: 0 })
    }
    if (url.endsWith('/diff')) return Response.json({ diff, files: ['src/a.ts'] })
    if (url.endsWith('/reviews')) {
      reviewCalls += 1
      // Le rafraîchissement qui suit le dispatch est laissé en suspens : sans
      // ça, la liste rejouée écraserait l'état qu'on veut observer.
      if (reviewCalls > 1) return new Promise<Response>(() => {})
      return Response.json([review])
    }
    return Response.json({ error: 'route inattendue' }, { status: 404 })
  }) as typeof fetch
  const confirm = window.confirm
  window.confirm = () => true
  try {
    await renderChanges()
    fireEvent.click(screen.getByRole('button', { name: 'Corriger les 2 ouverts' }))
    await waitFor(() => expect(dispatched.length).toBe(1))
    const progress = () => document.querySelector('.changes-progress')?.textContent ?? ''
    await waitFor(() => expect(progress()).toContain('1 correction en cours'))
    expect(progress()).not.toContain('2 corrections')
    expect(document.querySelectorAll('.diff-flag-state').length).toBe(1)
  } finally {
    window.confirm = confirm
  }
})
