import { expect, test } from 'bun:test'
import { reviewPreset } from './ReviewConfigSelector'
import type { Preset } from './types'

test('le preset Vitesse reprend exactement le modèle de conversation', () => {
  const preset: Preset = {
    id: 'builtin-speed',
    name: 'Vitesse',
    provider: 'codex',
    model: 'gpt-5.6-luna',
    effort: 'xhigh',
    speed: 'fast',
    orchestrator: true,
    permission_mode: null,
    review_provider: 'codex',
    review_model: 'gpt-5.6-sol',
    review_effort: 'high',
    built_in: true,
    created_at: '2026-08-13T00:00:00Z',
    updated_at: '2026-08-13T00:00:00Z',
  }

  expect(reviewPreset(preset)).toMatchObject({
    provider: 'codex',
    model: 'gpt-5.6-luna',
    effort: 'xhigh',
    speed: 'fast',
  })
})
