import type { Conversation, ConversationSpeed, Preset, Provider } from './types'

export interface CorrectionSelection {
  presetId: string
  provider: Provider
  model: string
  effort: string
  speed: ConversationSpeed
}

function storageKey(conversationId: string): string {
  return `pupitre:correction-config:${conversationId}`
}

export function defaultCorrectionSelection(conversation: Conversation): CorrectionSelection {
  return {
    presetId: '',
    provider: conversation.provider,
    model: conversation.model,
    effort: conversation.effort ?? 'high',
    speed: conversation.provider === 'codex' ? (conversation.speed ?? 'standard') : 'standard',
  }
}

export function correctionSelectionFromPreset(preset: Preset): CorrectionSelection {
  return {
    presetId: preset.id,
    provider: preset.provider,
    model: preset.model,
    effort: preset.effort ?? 'high',
    speed: preset.provider === 'codex' ? (preset.speed ?? 'standard') : 'standard',
  }
}

export function readCorrectionSelection(
  conversation: Conversation,
  storage: Pick<Storage, 'getItem'> = window.localStorage,
  fallback: CorrectionSelection = defaultCorrectionSelection(conversation),
): CorrectionSelection {
  try {
    const parsed = JSON.parse(storage.getItem(storageKey(conversation.id)) ?? 'null') as Partial<CorrectionSelection> | null
    if (!parsed || (parsed.provider !== 'codex' && parsed.provider !== 'claude')) return fallback
    if (typeof parsed.model !== 'string' || typeof parsed.effort !== 'string') return fallback
    return {
      presetId: typeof parsed.presetId === 'string' ? parsed.presetId : '',
      provider: parsed.provider,
      model: parsed.model,
      effort: parsed.effort,
      speed: parsed.provider === 'codex' && parsed.speed === 'fast' ? 'fast' : 'standard',
    }
  } catch {
    return fallback
  }
}

export function writeCorrectionSelection(
  conversationId: string,
  selection: CorrectionSelection,
  storage: Pick<Storage, 'setItem'> = window.localStorage,
): void {
  try { storage.setItem(storageKey(conversationId), JSON.stringify(selection)) } catch { /* choix conservé en mémoire */ }
}
