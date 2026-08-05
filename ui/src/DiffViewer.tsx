import { useMemo, useState } from 'react'
import { parseUnifiedDiff } from './reviewDiff'
import type { ReviewFlag } from './types'

interface DiffViewerProps {
  diff: string
  flags?: ReviewFlag[]
  label: string
}

export function DiffViewer({ diff, flags = [], label }: DiffViewerProps) {
  const [expandedFlagId, setExpandedFlagId] = useState<string | null>(null)
  const lines = useMemo(() => parseUnifiedDiff(diff, flags), [diff, flags])

  return (
    <div className="diff-table" role="table" aria-label={label}>
      {lines.map((line, index) => (
        <div
          className={`diff-line is-${line.kind} ${line.severity ? `risk-${line.severity}` : ''}`}
          role="row"
          key={`${index}-${line.text}`}
        >
          <span className="diff-number" role="cell">{line.oldLine ?? ''}</span>
          <span className="diff-number" role="cell">{line.newLine ?? ''}</span>
          <code role="cell">{line.text || ' '}</code>
          <span className="diff-flags" role="cell">
            {line.flags.map((flag) => (
              <button
                type="button"
                key={flag.id}
                className={`diff-flag-marker severity-${flag.severity}`}
                onClick={() => setExpandedFlagId(
                  expandedFlagId === flag.id ? null : flag.id,
                )}
                title={`${flag.category} — ${flag.message}`}
                aria-expanded={expandedFlagId === flag.id}
              >
                {expandedFlagId === flag.id ? flag.message : flag.category}
              </button>
            ))}
          </span>
        </div>
      ))}
    </div>
  )
}
