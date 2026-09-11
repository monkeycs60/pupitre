import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement, useState } from 'react'
import type { ConversationConfig } from './ConfigPanel'
import type { Preset, Project, QuotaSnapshot } from './types'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { ConfigPanel } = await import('./ConfigPanel')
const defaultFetch = globalThis.fetch

beforeEach(() => {
  localStorage.clear()
})

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

const quotas: QuotaSnapshot = { claude: null, codex: null, grok: null }

function servePresets(presets: Preset[]) {
  globalThis.fetch = mock((input: string | URL) => {
    const body = String(input).endsWith('/git')
      ? { branches: [], worktrees: [], commits: [], currentBranch: 'develop' }
      : presets
    return Promise.resolve(new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
  }) as unknown as typeof fetch
}

test('ouvre sur le preset par défaut du projet quand aucune mémoire n’existe', async () => {
  servePresets([speedPreset])
  const changes: ConversationConfig[] = []

  render(createElement(ConfigPanel, {
    project,
    quotas,
    config: initialConfig,
    memoryKey: project.id,
    onConfigChange: (next: ConversationConfig) => changes.push(next),
    onError: () => undefined,
  }))

  await waitFor(() => expect(changes.length).toBeGreaterThan(0))
  expect(changes.at(-1)).toEqual(expect.objectContaining({
    provider: 'codex',
    model: 'gpt-5.6-luna',
    effort: 'low',
  }))
})

test('la dernière configuration lancée revient avant le défaut du projet', async () => {
  servePresets([speedPreset])
  localStorage.setItem('pupitre:launch-config:project-1', JSON.stringify({
    provider: 'claude',
    model: 'opus',
    effort: 'xhigh',
    speed: 'standard',
    permissionMode: 'bypassPermissions',
    orchestrator: false,
    subagentPresetId: null,
    subagentEffort: null,
  }))
  const changes: ConversationConfig[] = []

  render(createElement(ConfigPanel, {
    project,
    quotas,
    config: initialConfig,
    memoryKey: project.id,
    onConfigChange: (next: ConversationConfig) => changes.push(next),
    onError: () => undefined,
  }))

  await waitFor(() => expect(changes.length).toBeGreaterThan(0))
  expect(changes.at(-1)).toEqual(expect.objectContaining({
    provider: 'claude',
    model: 'opus',
    effort: 'xhigh',
    permissionMode: 'bypassPermissions',
    orchestrator: false,
  }))
})

test('un modèle disparu du catalogue ne ressuscite pas par la mémoire', async () => {
  servePresets([speedPreset])
  localStorage.setItem('pupitre:launch-config:project-1', JSON.stringify({
    provider: 'claude',
    model: 'fable-3-retire',
    effort: 'high',
  }))
  const changes: ConversationConfig[] = []

  render(createElement(ConfigPanel, {
    project,
    quotas,
    config: initialConfig,
    memoryKey: project.id,
    onConfigChange: (next: ConversationConfig) => changes.push(next),
    onError: () => undefined,
  }))

  await waitFor(() => expect(changes.length).toBeGreaterThan(0))
  expect(changes.at(-1)).toEqual(expect.objectContaining({ model: 'gpt-5.6-luna' }))
})

test('changer un réglage écrit la mémoire du projet', async () => {
  servePresets([speedPreset])
  function Harness() {
    const [config, setConfig] = useState(initialConfig)
    return createElement(ConfigPanel, {
      project,
      quotas,
      config,
      memoryKey: project.id,
      onConfigChange: setConfig,
      onError: () => undefined,
    })
  }

  render(createElement(Harness))

  await waitFor(() => expect(screen.getByRole('radio', { name: 'Codex' }).getAttribute('aria-checked')).toBe('true'))
  fireEvent.click(screen.getByRole('radio', { name: 'Grok' }))

  await waitFor(() => {
    const raw = localStorage.getItem('pupitre:launch-config:project-1')
    expect(raw === null ? null : (JSON.parse(raw) as { model: string }).model).toBe('grok-4.6')
  })
})

test('sans clé de mémoire, rien n’est écrit : une bascule de modèle ne dicte pas le prochain lancement', async () => {
  servePresets([speedPreset])
  function Harness() {
    const [config, setConfig] = useState(initialConfig)
    return createElement(ConfigPanel, {
      project,
      quotas,
      config,
      applyProjectDefault: false,
      onConfigChange: setConfig,
      onError: () => undefined,
    })
  }

  render(createElement(Harness))

  fireEvent.click(await screen.findByRole('radio', { name: 'Grok' }))

  expect(localStorage.getItem('pupitre:launch-config:project-1')).toBeNull()
})

test("appliquer le défaut ne perd ni la branche ni le ticket", async () => {
  servePresets([speedPreset])
  const changes: ConversationConfig[] = []

  render(createElement(ConfigPanel, {
    project,
    quotas,
    config: { ...initialConfig, branch: 'feature/TECH-1', ticketKey: 'TECH-1' },
    memoryKey: project.id,
    onConfigChange: (next: ConversationConfig) => changes.push(next),
    onError: () => undefined,
  }))

  await waitFor(() => expect(changes.length).toBeGreaterThan(0))
  expect(changes.at(-1)).toEqual(expect.objectContaining({
    branch: 'feature/TECH-1',
    ticketKey: 'TECH-1',
  }))
})

test('un défaut de TODO remplace le défaut du projet', async () => {
  servePresets([
    speedPreset,
    { ...speedPreset, id: 'todo', name: 'TODO', provider: 'claude', model: 'haiku', effort: 'medium' },
  ])
  const changes: ConversationConfig[] = []

  render(createElement(ConfigPanel, {
    project: { ...project, default_todo_preset_id: 'todo' },
    quotas,
    config: initialConfig,
    defaultPresetId: 'todo',
    onConfigChange: (next: ConversationConfig) => changes.push(next),
    onError: () => undefined,
  }))

  await waitFor(() => expect(changes.length).toBeGreaterThan(0))
  expect(changes.at(-1)).toEqual(expect.objectContaining({
    presetId: 'todo',
    provider: 'claude',
    model: 'haiku',
    effort: 'medium',
  }))
})

test('la branche courante du dépôt sert de repère dans le champ', async () => {
  servePresets([speedPreset])

  render(createElement(ConfigPanel, {
    project,
    quotas,
    config: initialConfig,
    onConfigChange: () => undefined,
    onError: () => undefined,
    applyProjectDefault: false,
  }))

  await waitFor(() => {
    expect(screen.getByRole('combobox', { name: 'Branche cible' }).getAttribute('placeholder')).toBe('develop')
  })
})
