import { afterEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement, useState } from 'react'
import type { ConversationConfig } from './ConfigPanel'
import type { Preset, Project, QuotaSnapshot } from './types'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, render, screen } = await import('@testing-library/react')
const { ConfigPanel } = await import('./ConfigPanel')
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
  default_preset_id: 'speed',
  auto_counter_red: false,
  auto_rescan: false,
}

const speedPreset: Preset = {
  id: 'speed',
  name: 'Vitesse',
  provider: 'codex',
  model: 'gpt-5.6-luna',
  effort: 'low',
  speed: 'fast',
  permission_mode: null,
  orchestrator: true,
  subagent_preset_id: null,
  subagent_effort: null,
  review_provider: 'codex',
  review_model: 'gpt-5.6-sol',
  review_effort: 'high',
  built_in: true,
  created_at: '2026-08-09T00:00:00.000Z',
  updated_at: '2026-08-09T00:00:00.000Z',
}

const initialConfig: ConversationConfig = {
  provider: 'claude',
  model: 'fable-5',
  effort: 'high',
  speed: 'standard',
  permissionMode: null,
  orchestrator: true,
  subagentPresetId: null,
  subagentEffort: null,
}

const quotas: QuotaSnapshot = { claude: null, codex: null }

test('remplace le panneau de création par le chip du preset par défaut', async () => {
  globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify([speedPreset]), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }))) as typeof fetch
  function Harness() {
    const [config, setConfig] = useState(initialConfig)
    return createElement(ConfigPanel, {
      project,
      quotas,
      config,
      onConfigChange: setConfig,
      onProjectUpdated: () => undefined,
      onError: () => undefined,
    })
  }

  render(createElement(Harness))

  expect(await screen.findByRole('button', { name: /vitesse.*luna.*low/i })).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'Configuration' })).toBeNull()
})
