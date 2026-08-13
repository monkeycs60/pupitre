import { expect, test } from 'bun:test'
import { defaultCorrectionSelection, readCorrectionSelection, writeCorrectionSelection } from './correctionConfig'
import type { Conversation } from './types'

const conversation = {
  id: 'conversation-1', provider: 'codex', model: 'gpt-5.6-luna', effort: 'xhigh', speed: 'fast',
} as Conversation

test('le correcteur reprend le modèle de conversation par défaut', () => {
  expect(defaultCorrectionSelection(conversation)).toEqual({
    presetId: '', provider: 'codex', model: 'gpt-5.6-luna', effort: 'xhigh', speed: 'fast',
  })
})

test('le choix du correcteur survit au passage conversation ↔ code', () => {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
  }
  const selection = { presetId: 'quality', provider: 'claude' as const, model: 'opus', effort: 'high', speed: 'standard' as const }
  writeCorrectionSelection(conversation.id, selection, storage)
  expect(readCorrectionSelection(conversation, storage)).toEqual(selection)
})
