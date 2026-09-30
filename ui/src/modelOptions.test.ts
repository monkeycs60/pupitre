import { expect, test } from 'bun:test'
import * as options from './modelOptions'

test('propose Sonnet 5.5 avec son libellé et son tarif', () => {
  expect(options.PROVIDER_MODELS.claude).toContain('sonnet-5.5')
  expect(options.modelLabel('sonnet-5.5')).toBe('Sonnet 5.5')
  expect(options.formatModelPrice('sonnet-5.5')).toBe('2 / 10 $')
})

test('propose GPT-6.1 Sol avec son libellé et son tarif', () => {
  expect(options.PROVIDER_MODELS.codex).toContain('gpt-6.1-sol')
  expect(options.modelLabel('gpt-6.1-sol')).toBe('GPT-6.1 Sol')
  expect(options.formatModelPrice('gpt-6.1-sol')).toBe('2 / 10 $')
})

test('exprime le coût absolu et relatif des modèles à partir des tarifs API', () => {
  expect(options.modelCostTicks('gpt-5.6-luna')).toBe(1)
  expect(options.modelCostTicks('fable-5')).toBe(20)
  expect(options.modelCostTone('gpt-5.6-luna')).toBe('ok')
  expect(options.modelCostTone('opus')).toBe('danger')
  expect(options.relativeCostLabel('gpt-5.6-luna', 'gpt-5.6-sol')).toBe('÷25')
  expect(options.relativeCostLabel('gpt-5.6-sol', 'gpt-5.6-luna')).toBe('×25')
  expect(options.formatModelPrice('gpt-5.6-luna')).toBe('0,20 / 1,20 $')
})

test('demande une confirmation avant de lancer les modèles les plus coûteux', () => {
  expect(['fable-5.1', 'fable-5', 'gpt-6-astra'].every(options.requiresLaunchConfirmation)).toBe(true)
  expect(['opus', 'sonnet', 'gpt-5.6-sol', 'grok-4.6', 'go41'].some(options.requiresLaunchConfirmation)).toBe(false)
})
