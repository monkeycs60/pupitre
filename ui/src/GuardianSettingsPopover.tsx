import { CorrectionConfigSelector } from './CorrectionConfigSelector'
import { ReviewConfigSelector } from './ReviewConfigSelector'
import type { ReviewSelection } from './ReviewConfigSelector'
import type { CorrectionSelection } from './correctionConfig'
import type { Preset, QuotaSnapshot } from './types'

interface GuardianSettingsPopoverProps {
  review: ReviewSelection
  correction: CorrectionSelection
  presets: Preset[]
  quotas: QuotaSnapshot
  autoReview: boolean
  target: string
  busy?: boolean
  onReviewChange: (selection: ReviewSelection) => void
  onCorrectionChange: (selection: CorrectionSelection) => void
  onAutoReviewChange: (enabled: boolean) => void
}

export function GuardianSettingsPopover({
  review,
  correction,
  presets,
  quotas,
  autoReview,
  target,
  busy = false,
  onReviewChange,
  onCorrectionChange,
  onAutoReviewChange,
}: GuardianSettingsPopoverProps) {
  return (
    <div className="guardian-settings-popover" id="guardian-settings-popover" role="dialog" aria-label="Réglages du Gardien">
      <div className="guardian-settings-field">
        <span className="guardian-settings-label">Review</span>
        <ReviewConfigSelector
          value={review}
          presets={presets}
          quotas={quotas}
          busy={busy}
          placement="top"
          submenuPlacement="left"
          onChange={onReviewChange}
        />
      </div>
      <div className="guardian-settings-field">
        <span className="guardian-settings-label">Correction</span>
        <CorrectionConfigSelector
          value={correction}
          presets={presets}
          quotas={quotas}
          busy={busy}
          placement="top"
          submenuPlacement="left"
          onChange={onCorrectionChange}
        />
      </div>
      <div className="guardian-settings-divider" />
      <label className="guardian-settings-toggle">
        <input
          type="checkbox"
          checked={autoReview}
          onChange={(event) => onAutoReviewChange(event.target.checked)}
        />
        <span>Relire après chaque tour</span>
      </label>
      <p className="guardian-settings-target">Conversation → worktree <code>{target}</code></p>
    </div>
  )
}
