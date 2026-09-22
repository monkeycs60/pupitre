import { afterEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement, useState } from 'react'
import type { ConversationConfig } from './ConfigPanel'
import type { Provider, QuotaSnapshot } from './types'

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
}

function selector(overrides: Partial<Parameters<typeof ModelConfigSelector>[0]> = {}) {
  return createElement(ModelConfigSelector, {
    config,
    quotas: emptyQuotas,
    onConfigChange: () => undefined,
    ...overrides,
  })
}

test('les quatre providers sont proposés, seul le provider courant est coché', () => {
  render(selector())

  const providers = screen.getAllByRole('radio')
  expect(providers.map((button) => button.getAttribute('aria-label'))).toEqual(['Codex', 'Claude', 'Grok', 'OpenCode Go (Reasonix)'])
  expect(providers.filter((button) => button.getAttribute('aria-checked') === 'true'))
    .toEqual([screen.getByRole('radio', { name: 'Claude' })])
})

test('changer de provider applique le modèle et l’effort par défaut du provider', () => {
  let next: ConversationConfig | null = null
  render(selector({ onConfigChange: (config) => { next = config } }))

  fireEvent.click(screen.getByRole('radio', { name: 'Codex' }))

  expect(next).toEqual({ ...config, provider: 'codex', model: 'gpt-6-sol', effort: 'high' })
})

test('chaque provider arrive sur son réglage par défaut, pas son modèle le plus cher', () => {
  const expected: Array<{ label: string; provider: Provider; model: string; effort: string }> = [
    { label: 'Grok', provider: 'grok', model: 'grok-4.6', effort: 'high' },
    { label: 'OpenCode Go (Reasonix)', provider: 'reasonix', model: 'go41', effort: 'high' },
  ]

  for (const { label, provider, model, effort } of expected) {
    let next: ConversationConfig | null = null
    const { unmount } = render(selector({
      config: { ...config, effort: 'max' },
      onConfigChange: (config) => { next = config },
    }))

    fireEvent.click(screen.getByRole('radio', { name: label }))

    expect(next).toEqual({ ...config, provider, model, effort })
    unmount()
  }
})

test('la mémoire par provider prime sur le défaut au retour', () => {
  function Harness() {
    const [value, setValue] = useState<ConversationConfig>(config)
    return createElement(ModelConfigSelector, {
      config: value,
      quotas: emptyQuotas,
      onConfigChange: setValue,
    })
  }

  render(createElement(Harness))

  fireEvent.click(screen.getByRole('radio', { name: 'Codex' }))
  expect(screen.getByRole('button', { name: 'Modèle' }).textContent).toContain('GPT-6 Sol')

  // Claude n'a jamais été quitté avec un autre réglage : son dernier choix
  // (fable-5/high) revient, pas son défaut opus/medium.
  fireEvent.click(screen.getByRole('radio', { name: 'Claude' }))
  expect(screen.getByRole('button', { name: 'Modèle' }).textContent).toContain('Fable 5')
  expect(screen.getByRole('button', { name: 'Effort' }).textContent).toContain('high')
})

test('le menu des modèles ne liste que ceux du provider courant', () => {
  render(selector({ config: { ...config, provider: 'grok', model: 'grok-4.6' } }))

  fireEvent.click(screen.getByRole('button', { name: 'Modèle' }))

  expect(screen.getAllByRole('menuitemradio').map((item) => item.getAttribute('aria-label')))
    .toEqual(['Grok 4.6', 'Grok 4.5'])
})

test('choisir un modèle ne touche qu’au modèle', () => {
  let next: ConversationConfig | null = null
  render(selector({ onConfigChange: (config) => { next = config } }))

  fireEvent.click(screen.getByRole('button', { name: 'Modèle' }))
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Haiku 4.5' }))

  expect(next).toEqual({ ...config, model: 'haiku' })
  expect(screen.queryByRole('menu', { name: 'Choisir un modèle' })).toBeNull()
})

test('l’effort propose les cinq crans de Claude et quatre chez Codex', () => {
  const { unmount } = render(selector())
  fireEvent.click(screen.getByRole('button', { name: 'Effort' }))
  expect(screen.getAllByRole('menuitemradio')).toHaveLength(5)
  unmount()

  render(selector({ config: { ...config, provider: 'codex', model: 'gpt-5.6-sol' } }))
  fireEvent.click(screen.getByRole('button', { name: 'Effort' }))
  expect(screen.getAllByRole('menuitemradio')).toHaveLength(4)
})

test('la vitesse n’apparaît que pour Codex', () => {
  const { unmount } = render(selector())
  fireEvent.click(screen.getByRole('button', { name: 'Réglages du tour' }))
  expect(screen.queryByRole('menuitemradio', { name: /rapide/i })).toBeNull()
  unmount()

  render(selector({ config: { ...config, provider: 'codex', model: 'gpt-5.6-sol' } }))
  fireEvent.click(screen.getByRole('button', { name: 'Réglages du tour' }))
  expect(screen.getByRole('menuitemradio', { name: /rapide/i })).toBeTruthy()
})

test('sans réglages de conversation, un provider non-Codex n’a aucun panneau de réglages', () => {
  render(selector({ showConversationSettings: false }))

  expect(screen.queryByRole('button', { name: 'Réglages du tour' })).toBeNull()
})

test('YOLO reste visible hors du panneau', () => {
  render(selector({ config: { ...config, permissionMode: 'bypassPermissions' } }))

  expect(screen.getByText('YOLO')).toBeTruthy()
})

test('l’autonomie est une échelle ordonnée, du plus borné au plus ouvert', () => {
  render(selector())
  fireEvent.click(screen.getByRole('button', { name: 'Réglages du tour' }))

  const options = screen.getAllByRole('menuitemradio')
    .filter((option) => option.className.includes('autonomy-option'))
    .map((option) => option.querySelector('strong')?.textContent)

  expect(options).toEqual([
    'Hériter du projet',
    'Plan / lecture seule',
    'Éditions acceptées',
    'Autonome',
    'YOLO · sans permissions',
  ])
})

test('chaque rang porte une jauge plus haute que le précédent', () => {
  render(selector())
  fireEvent.click(screen.getByRole('button', { name: 'Réglages du tour' }))

  const lit = screen.getAllByRole('menuitemradio')
    .filter((option) => !option.className.includes('is-inherit'))
    .filter((option) => option.className.includes('autonomy-option'))
    .map((option) => option.querySelectorAll('.autonomy-gauge i.is-on').length)

  expect(lit).toEqual([1, 2, 3, 4])
})

test('l’héritage annonce le réglage du projet qu’il suit', () => {
  render(selector({ projectPermissionMode: 'bypassPermissions' }))
  fireEvent.click(screen.getByRole('button', { name: 'Réglages du tour' }))

  const inherit = screen.getAllByRole('menuitemradio')
    .find((option) => option.className.includes('is-inherit'))!
  expect(inherit.querySelector('small')?.textContent)
    .toContain('yolo · sans permissions')
})

test('choisir un rang le renvoie sans toucher au reste de la configuration', () => {
  let next: ConversationConfig | null = null
  render(selector({ onConfigChange: (config) => { next = config } }))

  fireEvent.click(screen.getByRole('button', { name: 'Réglages du tour' }))
  fireEvent.click(screen.getByRole('menuitemradio', { name: /Autonome/ }))

  expect(next).toEqual({ ...config, permissionMode: 'dontAsk' })
})

/**
 * `getBoundingClientRect` renvoie des zéros sous happy-dom : on déclare la
 * géométrie à la main pour mesurer ce que le composant décide à partir d'elle.
 */
function stubGeometry(cellTop: number, popHeight: number) {
  const original = Element.prototype.getBoundingClientRect
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const rect = (height: number, top: number, right = 0): DOMRect => ({
      x: 0, y: top, top, bottom: top + height, left: 0, right,
      width: right, height, toJSON: () => ({}),
    }) as DOMRect
    if (this.classList.contains('model-strip-cell')) return rect(30, cellTop)
    if (this.classList.contains('model-strip-pop')) return rect(popHeight, cellTop - 6 - popHeight)
    return original.call(this)
  }
  return () => { Element.prototype.getBoundingClientRect = original }
}

test('le panneau se borne à la place disponible au lieu de sortir par le haut', () => {
  const restore = stubGeometry(300, 520)
  try {
    render(selector())
    fireEvent.click(screen.getByRole('button', { name: 'Modèle' }))

    // 300 px au-dessus de la cellule, moins 6 px d'écart et 8 px de marge.
    expect((document.querySelector('.model-strip-pop') as HTMLElement).style.maxHeight).toBe('286px')
  } finally {
    restore()
  }
})

test('garde le panneau entier quand la place au-dessus suffit', () => {
  const restore = stubGeometry(900, 520)
  try {
    render(selector())
    fireEvent.click(screen.getByRole('button', { name: 'Modèle' }))

    expect((document.querySelector('.model-strip-pop') as HTMLElement).style.maxHeight).toBe('')
  } finally {
    restore()
  }
})
