import { afterEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { ConversationConfig } from './ConfigPanel'
import type { Preset, QuotaSnapshot } from './types'

if (typeof document === 'undefined') GlobalRegistrator.register()

const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const { ModelConfigSelector } = await import('./ModelConfigSelector')

afterEach(cleanup)

const emptyQuotas: QuotaSnapshot = { claude: null, codex: null, grok: null }

const config: ConversationConfig = {
  provider: 'claude',
  model: 'fable-5',
  effort: 'high',
  speed: 'standard',
  permissionMode: null,
  orchestrator: true,
  subagentPresetId: null,
  subagentEffort: null,
}

function preset(index: number): Preset {
  return {
    id: `preset-${index}`,
    name: `Preset ${index}`,
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
    built_in: false,
    created_at: '2026-08-09T00:00:00.000Z',
    updated_at: '2026-08-09T00:00:00.000Z',
  }
}

test('permet de sélectionner le cent-unième preset sans limiter la liste', () => {
  let selectedPresetId: string | null = null
  render(createElement(ModelConfigSelector, {
    config,
    presets: Array.from({ length: 101 }, (_, index) => preset(index + 1)),
    selectedPresetId: '',
    quotas: emptyQuotas,
    onConfigChange: () => undefined,
    onPresetSelect: (next) => { selectedPresetId = next.id },
  }))

  fireEvent.click(screen.getByRole('button', { name: /réglages libres/i }))
  fireEvent.click(screen.getByRole('menuitemradio', { name: /preset 101/i }))

  expect(selectedPresetId).toBe('preset-101')
})

test('choisir un modèle d’un autre provider réinitialise les réglages dépendants', () => {
  let nextConfig: ConversationConfig | null = null
  render(createElement(ModelConfigSelector, {
    config,
    presets: [],
    selectedPresetId: '',
    quotas: emptyQuotas,
    onConfigChange: (next) => { nextConfig = next },
    onPresetSelect: () => undefined,
  }))

  fireEvent.click(screen.getByRole('button', { name: /réglages libres/i }))
  fireEvent.click(screen.getByRole('button', { name: 'Modèle' }))
  fireEvent.click(screen.getByRole('menuitemradio', { name: '5.6 Luna' }))

  expect(nextConfig).toEqual({
    ...config,
    provider: 'codex',
    model: 'gpt-5.6-luna',
    effort: 'high',
    speed: 'standard',
  })
})

test('ouvre le sous-menu modèle avec la flèche droite', () => {
  render(createElement(ModelConfigSelector, {
    config,
    presets: [],
    selectedPresetId: '',
    quotas: emptyQuotas,
    onConfigChange: () => undefined,
    onPresetSelect: () => undefined,
  }))

  fireEvent.click(screen.getByRole('button', { name: /réglages libres/i }))
  const modelButton = screen.getByRole('button', { name: 'Modèle' })
  modelButton.focus()
  fireEvent.keyDown(modelButton, { key: 'ArrowRight' })

  expect(screen.getByRole('menu', { name: 'Choisir un modèle' })).toBeTruthy()
})

test('ancre chaque sous-menu à son réglage déclencheur', () => {
  render(createElement(ModelConfigSelector, {
    config: { ...config, provider: 'codex', model: 'gpt-5.6-luna' },
    presets: [],
    selectedPresetId: '',
    quotas: emptyQuotas,
    onConfigChange: () => undefined,
    onPresetSelect: () => undefined,
  }))

  fireEvent.click(screen.getByRole('button', { name: /réglages libres/i }))

  for (const [trigger, menuName] of [
    ['Modèle', 'Choisir un modèle'],
    ['Effort', 'Choisir l’effort'],
    ['Vitesse', 'Choisir la vitesse'],
    ['Autonomie', 'Choisir l’autonomie'],
    ['Sub-agents', 'Configurer les sub-agents'],
  ]) {
    fireEvent.click(screen.getByRole('button', { name: trigger }))
    const submenu = screen.getByRole('menu', { name: menuName })
    expect(submenu.parentElement?.classList.contains('preset-selector-setting')).toBe(true)
    expect(submenu.parentElement?.querySelector(`[aria-label="${trigger}"]`)).toBeTruthy()
  }
})

test('liste les modèles Grok dans le sous-menu', () => {
  render(createElement(ModelConfigSelector, {
    config,
    presets: [],
    selectedPresetId: '',
    quotas: emptyQuotas,
    onConfigChange: () => undefined,
    onPresetSelect: () => undefined,
  }))

  fireEvent.click(screen.getByRole('button', { name: /réglages libres/i }))
  fireEvent.click(screen.getByRole('button', { name: 'Modèle' }))

  const selector = screen.getByRole('menu', { name: 'Choisir un modèle' }).closest('.preset-selector')
  expect(selector?.classList.contains('opens-top')).toBe(true)
  expect(screen.getByRole('menuitemradio', { name: 'Grok 4.6' })).toBeTruthy()
})

test('peut ouvrir les sous-menus vers la gauche dans un en-tête droit', () => {
  render(createElement(ModelConfigSelector, {
    config,
    presets: [],
    selectedPresetId: '',
    quotas: emptyQuotas,
    submenuPlacement: 'left',
    onConfigChange: () => undefined,
    onPresetSelect: () => undefined,
  }))

  fireEvent.click(screen.getByRole('button', { name: /réglages libres/i }))
  fireEvent.click(screen.getByRole('button', { name: 'Modèle' }))

  expect(screen.getByRole('menu', { name: 'Choisir un modèle' }).closest('.preset-selector')?.classList.contains('submenus-left')).toBe(true)
})

test('conserve le réglage d’effort des sub-agents dans le menu compact', () => {
  let nextConfig: ConversationConfig | null = null
  render(createElement(ModelConfigSelector, {
    config,
    presets: [],
    selectedPresetId: '',
    quotas: emptyQuotas,
    onConfigChange: (next) => { nextConfig = next },
    onPresetSelect: () => undefined,
  }))

  fireEvent.click(screen.getByRole('button', { name: /réglages libres/i }))
  fireEvent.click(screen.getByRole('button', { name: 'Sub-agents' }))
  fireEvent.change(screen.getByLabelText('Effort sub-agent'), { target: { value: 'xhigh' } })

  expect(nextConfig).toEqual({ ...config, subagentEffort: 'xhigh' })
})
