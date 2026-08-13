import { expect, test } from 'bun:test'
import * as options from './modelOptions'

test('exprime le coût absolu et relatif des modèles à partir des tarifs API', () => {
  expect(options.modelCostTicks('gpt-5.6-luna')).toBe(1)
  expect(options.modelCostTicks('fable-5')).toBe(20)
  expect(options.modelCostTone('gpt-5.6-luna')).toBe('ok')
  expect(options.modelCostTone('opus')).toBe('danger')
  expect(options.relativeCostLabel('gpt-5.6-luna', 'gpt-5.6-sol')).toBe('÷25')
  expect(options.relativeCostLabel('gpt-5.6-sol', 'gpt-5.6-luna')).toBe('×25')
  expect(options.formatModelPrice('gpt-5.6-luna')).toBe('0,20 / 1,20 $')
})

test('Gardien propose exactement les modèles disponibles dans le chat', () => {
  expect(options.REVIEW_MODELS).toBe(options.PROVIDER_MODELS)
  expect(options.REVIEW_MODELS.codex).toContain('gpt-5.6-luna')
  expect(options.REVIEW_MODELS.claude).toContain('haiku')
})
