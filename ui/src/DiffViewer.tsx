import { useMemo, useState } from 'react'
import { parseUnifiedDiff } from './reviewDiff'
import type { DiffLine } from './reviewDiff'
import type { ReviewFlag } from './types'

interface DiffViewerProps {
  diff: string
  flags?: ReviewFlag[]
  label: string
}

type DiffRow =
  | { type: 'file'; file: string }
  | { type: 'line'; line: DiffLine }

/* Préambule Git redondant avec l'en-tête de fichier collant. */
const HIDDEN_META_PREFIXES = ['diff --git ', 'index ', '--- ', '+++ ']

function toRows(lines: DiffLine[]): DiffRow[] {
  const rows: DiffRow[] = []
  let announcedFile: string | null = null
  for (const line of lines) {
    if (line.kind === 'meta') {
      if (line.text === '') continue
      const gitHeader = line.text.match(/^diff --git a\/.+ b\/(.+)$/)
      if (gitHeader) {
        rows.push({ type: 'file', file: gitHeader[1] })
        announcedFile = gitHeader[1]
        continue
      }
      if (HIDDEN_META_PREFIXES.some((prefix) => line.text.startsWith(prefix))) continue
    } else if (line.file !== null && line.file !== announcedFile) {
      rows.push({ type: 'file', file: line.file })
      announcedFile = line.file
    }
    rows.push({ type: 'line', line })
  }
  return rows
}

export function DiffViewer({ diff, flags = [], label }: DiffViewerProps) {
  const [expandedFlagId, setExpandedFlagId] = useState<string | null>(null)
  const rows = useMemo(() => toRows(parseUnifiedDiff(diff, flags)), [diff, flags])

  return (
    <div className="diff-table" role="table" aria-label={label}>
      {rows.map((row, index) => row.type === 'file' ? (
        <div className="diff-file-header" role="row" key={`${index}-${row.file}`}>
          <span role="cell">{row.file}</span>
        </div>
      ) : (
        <div
          className={`diff-line is-${row.line.kind} ${row.line.severity ? `risk-${row.line.severity}` : ''}`}
          role="row"
          key={`${index}-${row.line.text}`}
        >
          <span className="diff-number" role="cell">{row.line.oldLine ?? ''}</span>
          <span className="diff-number" role="cell">{row.line.newLine ?? ''}</span>
          <code role="cell">{row.line.text || ' '}</code>
          <span className="diff-flags" role="cell">
            {row.line.flags.map((flag) => (
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
