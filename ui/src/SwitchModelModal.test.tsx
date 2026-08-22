import { afterEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { Conversation, Preset, Project, QuotaSnapshot } from './types'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { SwitchModelModal } = await import('./SwitchModelModal')
const defaultFetch = globalThis.fetch

afterEach(() => {
  cleanup()
  globalThis.fetch = defaultFetch
})

const project: Project = {
  id: 'project-1',
  name: 'Pupitre',
  path: '/tmp/pupitre',
  permission_mode: 'acceptEdits',
  filesystem_scope: 'project-and-ai-roots',
  pinned: false,
  created_at: '2026-08-09T00:00:00.000Z',
  default_preset_id: null,
  auto_counter_red: false,
  auto_rescan: false,
}

const conversation: Conversation = {
  id: 'conversation-1',
  project_id: project.id,
  title: 'Sélecteur',
  summary: '',
  provider: 'codex',
  model: 'gpt-5.6-luna',
  effort: 'low',
  speed: 'standard',
  permission_mode: null,
  orchestrator: true,
  subagent_preset_id: null,
  subagent_effort: null,
  continued_from: null,
  routine_id: null,
  worktree_path: null,
  created_on_branch: null,
  ticket_id: null,
  cli_session_id: null,
  pinned: false,
  title_locked: false,
  digest_turn: 0,
  archived: false,
  deleted_at: null,
  created_at: '2026-08-09T00:00:00.000Z',
  updated_at: '2026-08-09T00:00:00.000Z',
}

const fablePreset: Preset = {
  id: 'quality',
  name: 'Qualité max',
  provider: 'claude',
  model: 'fable-5',
  effort: 'high',
  speed: null,
  permission_mode: null,
  orchestrator: true,
  subagent_preset_id: null,
  subagent_effort: null,
  review_provider: 'claude',
  review_model: 'opus',
  review_effort: 'high',
  built_in: true,
  created_at: '2026-08-09T00:00:00.000Z',
  updated_at: '2026-08-09T00:00:00.000Z',
}

const quotas: QuotaSnapshot = { claude: null, codex: null, grok: null }

test('confirme une passation Claude après une sélection dans le même sélecteur', async () => {
  let handoffPayload: unknown = null
  const nextConversation = { ...conversation, id: 'conversation-2', provider: 'claude' as const, model: 'fable-5' }
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === '/api/presets') {
      return new Response(JSON.stringify([fablePreset]), { status: 200 })
    }
    if (String(input) === '/api/conversations/conversation-1/handoff') {
      handoffPayload = JSON.parse(String(init?.body))
      return new Response(JSON.stringify(nextConversation), { status: 200 })
    }
    throw new Error(`Requête inattendue : ${String(input)}`)
  }
  const handoffs: Conversation[] = []

  render(createElement(SwitchModelModal, {
    conversation,
    events: [],
    project,
    quotas,
    onProjectUpdated: () => undefined,
    onClose: () => undefined,
    onSwitched: () => undefined,
    onHandoff: (next) => { handoffs.push(next) },
  }))

  fireEvent.click(await screen.findByRole('button', { name: /réglages libres/i }))
  expect(screen.queryByRole('button', { name: 'Autonomie' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Sub-agents' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Modèle' }))
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Fable 5' }))
  fireEvent.click(screen.getByRole('button', { name: 'Passer à claude' }))

  await waitFor(() => expect(handoffs).toEqual([nextConversation]))
  expect(handoffPayload).toEqual({
    provider: 'claude',
    model: 'fable-5',
    effort: 'high',
    speed: null,
    orchestrator: true,
  })
})
