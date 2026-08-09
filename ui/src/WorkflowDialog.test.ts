import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { Project, SkillSummary, Workflow } from './types'

if (typeof document === 'undefined') GlobalRegistrator.register()

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const skillLoads: Array<Deferred<Response>> = []

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { WorkflowDialog } = await import('./WorkflowDialog')
const defaultFetch = globalThis.fetch

afterEach(() => {
  cleanup()
  skillLoads.length = 0
  globalThis.fetch = defaultFetch
})

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function installApi() {
  globalThis.fetch = mock((input: RequestInfo | URL): Promise<Response> => {
    const path = String(input)
    if (path.startsWith('/api/skills?')) {
      const load = deferred<Response>()
      skillLoads.push(load)
      return load.promise
    }
    if (path === '/api/presets') return Promise.resolve(jsonResponse([]))
    return Promise.reject(new Error(`Requête inattendue : ${path}`))
  }) as typeof fetch
}

function project(id: string): Project {
  return {
    id,
    name: id,
    path: `/tmp/${id}`,
    permission_mode: 'acceptEdits',
    filesystem_scope: 'project-and-ai-roots',
    pinned: false,
    created_at: '2026-08-08T08:00:00.000Z',
    default_preset_id: null,
    auto_counter_red: false,
    auto_rescan: false,
  }
}

const skill: SkillSummary = {
  id: 'skill-review',
  name: 'Diff review',
  invocation: 'diff-review',
  description: 'Relit un diff.',
  triggers: [],
  provider: 'codex',
  provenance: 'agents-project',
  path: '/tmp/skills/diff-review/SKILL.md',
  project_id: 'project-1',
  modified_at: '2026-08-08T08:00:00.000Z',
  indexed_at: '2026-08-08T08:00:00.000Z',
  favorite: true,
}

const workflow: Workflow = {
  id: 'workflow-review',
  project_id: 'project-1',
  name: 'Revue initiale',
  skill_id: skill.id,
  skill_name: skill.name,
  skill_invocation: skill.invocation,
  prompt: 'Relis le diff.',
  preset_id: 'builtin-quality',
  provider: 'codex',
  model: 'gpt-5.6-sol',
  effort: 'high',
  speed: 'standard',
  orchestrator: true,
  created_at: '2026-08-08T08:00:00.000Z',
  updated_at: '2026-08-08T08:00:00.000Z',
}

test('le préremplissage initial ne réécrase pas la saisie après un nouveau chargement des skills', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  installApi()
  const firstProject = project('project-1')
  const props = {
    project: firstProject,
    workflows: [workflow],
    initialWorkflow: workflow,
    onClose: () => undefined,
    onChanged: () => undefined,
  }
  const view = render(createElement(WorkflowDialog, props))

  await waitFor(() => expect(skillLoads).toHaveLength(1))
  await act(async () => {
    skillLoads[0]!.resolve(jsonResponse([skill]))
  })

  const nameInput = await screen.findByLabelText('Nom du workflow') as HTMLInputElement
  await waitFor(() => expect(nameInput.value).toBe('Revue initiale'))
  fireEvent.change(nameInput, { target: { value: 'Saisie utilisateur' } })
  expect(nameInput.value).toBe('Saisie utilisateur')

  view.rerender(createElement(WorkflowDialog, { ...props, project: project('project-2') }))
  await waitFor(() => expect(skillLoads).toHaveLength(2))
  await act(async () => {
    skillLoads[1]!.resolve(jsonResponse([{ ...skill, name: 'Diff review actualisé' }]))
  })

  expect(nameInput.value).toBe('Saisie utilisateur')
})
