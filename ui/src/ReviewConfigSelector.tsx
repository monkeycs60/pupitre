import { ModelConfigSelector } from './ModelConfigSelector'
import type { ConversationConfig } from './ConfigPanel'
import type { ConversationSpeed, Preset, Provider, QuotaSnapshot } from './types'

export interface ReviewSelection {
  presetId: string
  provider: Provider
  model: string
  effort: string
  speed: ConversationSpeed
}

interface Props {
  value: ReviewSelection
  presets: Preset[]
  quotas: QuotaSnapshot
  busy?: boolean
  placement?: 'top' | 'bottom'
  onChange: (value: ReviewSelection) => void
}

export function reviewPreset(preset: Preset): Preset {
  // « Vitesse » est un même choix dans le chat et dans Gardien : ses réglages
  // suivent donc le preset courant, y compris après une personnalisation.
  if (preset.id === 'builtin-speed') {
    return {
      ...preset,
      speed: preset.provider === 'codex' ? (preset.speed ?? 'standard') : null,
      orchestrator: false,
      subagent_preset_id: null,
      subagent_effort: null,
      permission_mode: null,
    }
  }
  return {
    ...preset,
    provider: preset.review_provider,
    model: preset.review_model,
    effort: preset.review_effort,
    speed: preset.review_provider === 'codex' ? (preset.speed ?? 'standard') : null,
    orchestrator: false,
    subagent_preset_id: null,
    subagent_effort: null,
    permission_mode: null,
  }
}

function selectionConfig(value: ReviewSelection): ConversationConfig {
  return {
    presetId: value.presetId || null,
    provider: value.provider,
    model: value.model,
    effort: value.effort,
    speed: value.provider === 'codex' ? value.speed : 'standard',
    permissionMode: null,
    orchestrator: false,
    subagentPresetId: null,
    subagentEffort: null,
  }
}

function selectionFromConfig(config: ConversationConfig, presets: Preset[]): ReviewSelection {
  const match = presets.find((preset) => {
    const transformed = reviewPreset(preset)
    return transformed.provider === config.provider
      && transformed.model === config.model
      && transformed.effort === config.effort
      && (config.provider !== 'codex' || (transformed.speed ?? 'standard') === config.speed)
  })
  return {
    presetId: match?.id ?? '',
    provider: config.provider,
    model: config.model,
    effort: config.effort,
    speed: config.provider === 'codex' ? config.speed : 'standard',
  }
}

export function ReviewConfigSelector({ value, presets, quotas, busy, placement = 'top', onChange }: Props) {
  const reviewPresets = presets.map(reviewPreset)
  return (
    <div className="review-config-selector">
      <ModelConfigSelector
        config={selectionConfig(value)}
        presets={reviewPresets}
        selectedPresetId={value.presetId}
        quotas={quotas}
        isBusy={busy}
        showConversationSettings={false}
        placement={placement}
        onConfigChange={(config) => onChange(selectionFromConfig(config, presets))}
        onPresetSelect={(preset) => onChange({
          presetId: preset.id,
          provider: preset.provider,
          model: preset.model,
          effort: preset.effort ?? 'high',
          speed: preset.provider === 'codex' ? (preset.speed ?? 'standard') : 'standard',
        })}
      />
    </div>
  )
}
