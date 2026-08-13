import { ModelConfigSelector } from './ModelConfigSelector'
import type { ConversationConfig } from './ConfigPanel'
import type { CorrectionSelection } from './correctionConfig'
import type { Preset, QuotaSnapshot } from './types'

interface Props {
  value: CorrectionSelection
  presets: Preset[]
  quotas: QuotaSnapshot
  busy?: boolean
  placement?: 'top' | 'bottom'
  submenuPlacement?: 'left' | 'right'
  onChange: (selection: CorrectionSelection) => void
}

function modelConfig(value: CorrectionSelection): ConversationConfig {
  return {
    presetId: value.presetId || null,
    provider: value.provider,
    model: value.model,
    effort: value.effort,
    speed: value.speed,
    permissionMode: null,
    orchestrator: false,
    subagentPresetId: null,
    subagentEffort: null,
  }
}

export function CorrectionConfigSelector({
  value,
  presets,
  quotas,
  busy,
  placement = 'top',
  submenuPlacement = 'right',
  onChange,
}: Props) {
  return (
    <div className="correction-config-selector">
      <ModelConfigSelector
        config={modelConfig(value)}
        presets={presets}
        selectedPresetId={value.presetId}
        quotas={quotas}
        isBusy={busy}
        showConversationSettings={false}
        placement={placement}
        submenuPlacement={submenuPlacement}
        onConfigChange={(config) => onChange({
          presetId: config.presetId ?? '',
          provider: config.provider,
          model: config.model,
          effort: config.effort,
          speed: config.provider === 'codex' ? config.speed : 'standard',
        })}
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
