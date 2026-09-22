import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement, useState } from 'react'
import type { ConversationConfig } from './ConfigPanel'
import type { Preset, Project, QuotaSnapshot } from './types'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { ConfigPanel } = await import('./ConfigPanel')
const { readLaunchConfig, writeLaunchConfig } = await import('./configMemory')
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
  localStorage.setItem('pupitre:launch-config:v2:project-1', JSON.stringify({
    provider: 'claude',
    model: 'opus',
    effort: 'xhigh',
    speed: 'standard',
    permissionMode: 'bypassPermissions',
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
  }))
})

test('un modèle disparu du catalogue ne ressuscite pas par la mémoire', async () => {
  servePresets([speedPreset])
  localStorage.setItem('pupitre:launch-config:v2:project-1', JSON.stringify({
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

test('un modèle soumis à confirmation ne revient pas par la mémoire', async () => {
  servePresets([speedPreset])
  localStorage.setItem('pupitre:launch-config:v2:project-1', JSON.stringify({
    provider: 'claude',
    model: 'fable-5.1',
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

test('choisir Fable garde en mémoire le dernier modèle ordinaire', () => {
  const base = { presetId: null, effort: 'low', speed: 'standard' as const, permissionMode: null }
  writeLaunchConfig(project.id, { ...base, provider: 'codex', model: 'gpt-5.6-sol' })
  writeLaunchConfig(project.id, { ...base, provider: 'claude', model: 'fable-5.1', effort: 'high' })
  expect(readLaunchConfig(project.id)).toEqual(expect.objectContaining({ model: 'gpt-5.6-sol', effort: 'low' }))
})

test('un preset par défaut soumis à confirmation cède la place au réglage du provider', async () => {
  const builtinSpeed = { ...speedPreset, id: 'builtin-speed' }
  servePresets([{ ...speedPreset, provider: 'claude', model: 'fable-5.1', effort: 'high' }, builtinSpeed])
  const changes: ConversationConfig[] = []
  let ready = false

  render(createElement(ConfigPanel, {
    project,
    quotas,
    config: initialConfig,
    memoryKey: project.id,
    onConfigChange: (next: ConversationConfig) => changes.push(next),
    onError: () => undefined,
    onReady: (value: boolean) => { ready = value },
  }))

  await waitFor(() => expect(ready).toBe(true))
  expect(changes).toEqual([])
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
    const raw = localStorage.getItem('pupitre:launch-config:v2:project-1')
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

  expect(localStorage.getItem('pupitre:launch-config:v2:project-1')).toBeNull()
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

test('cumule la même branche dans plusieurs dépôts', async () => {
  const options = [
    { name: 'feature/TECH-25008', fullName: 'refs/heads/feature/TECH-25008', sha: 'a', current: false, remote: false, repositoryPath: '/mono/apps/hapigator', repositoryLabel: 'apps/hapigator' },
    { name: 'feature/TECH-25008', fullName: 'refs/heads/feature/TECH-25008', sha: 'b', current: false, remote: false, repositoryPath: '/mono/apps/reactor', repositoryLabel: 'apps/reactor' },
  ]
  globalThis.fetch = mock((input: string | URL) => Promise.resolve(new Response(JSON.stringify(
    String(input).endsWith('/git')
      ? { branches: [], branchOptions: options, worktrees: [], commits: [], currentBranch: 'main' }
      : [speedPreset],
  ), { status: 200, headers: { 'content-type': 'application/json' } }))) as unknown as typeof fetch
  let latest = initialConfig
  function Controlled() {
    const [config, setConfig] = useState(initialConfig)
    latest = config
    return createElement(ConfigPanel, {
      project, quotas, config, onConfigChange: setConfig, onError: () => undefined, applyProjectDefault: false,
    })
  }
  render(createElement(Controlled))

  const input = await screen.findByRole('combobox', { name: 'Branche cible' })
  fireEvent.change(input, { target: { value: '25008' } })
  fireEvent.click((await screen.findAllByRole('option'))[0]!)
  fireEvent.click((await screen.findAllByRole('option'))[1]!)

  expect(latest.workspaces?.map((item) => item.repositoryLabel)).toEqual(['apps/hapigator', 'apps/reactor'])
  expect(screen.getByText('2 dépôts')).toBeTruthy()
})
