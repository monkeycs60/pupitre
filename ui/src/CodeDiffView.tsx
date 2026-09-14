import { useEffect, useMemo, useState } from 'react'
import { escapeHtml, highlightCode } from './codeHighlight'
import { useVirtualWindow } from './useVirtualWindow'

const ROW_HEIGHT = 20
const HIDDEN_META = /^(diff --git |index |--- |\+\+\+ |similarity index |rename from |rename to |new file mode |deleted file mode |old mode |new mode )/

interface DiffLine {
  kind: 'addition' | 'deletion' | 'context' | 'meta'
  text: string
  oldLine: number | null
  newLine: number | null
}

function parseUnifiedDiff(diff: string): DiffLine[] {
  let oldLine: number | null = null
  let newLine: number | null = null
  return diff.split('\n').map((text) => {
    const hunk = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      return { kind: 'meta', text, oldLine: null, newLine: null }
    }
    if (oldLine === null || newLine === null || text.startsWith('diff ') || text.startsWith('index ') || text.startsWith('--- ') || text.startsWith('+++ ')) {
      return { kind: 'meta', text, oldLine: null, newLine: null }
    }
    if (text.startsWith('+')) return { kind: 'addition', text, oldLine: null, newLine: newLine++ }
    if (text.startsWith('-')) return { kind: 'deletion', text, oldLine: oldLine++, newLine: null }
    const row = { kind: 'context' as const, text, oldLine, newLine }
    oldLine += 1
    newLine += 1
    return row
  })
}

function codeDiffRows(diff: string): DiffLine[] {
  return parseUnifiedDiff(diff).filter((line) => line.kind !== 'meta' || (line.text !== '' && !HIDDEN_META.test(line.text)))
}

function isCodeLine(line: DiffLine): boolean {
  return line.kind === 'addition' || line.kind === 'deletion' || line.kind === 'context'
}

export function CodeDiffView({ diff, path }: { diff: string, path: string }) {
  const rows = useMemo(() => codeDiffRows(diff), [diff])
  const texts = useMemo(() => rows.map((row) => (isCodeLine(row) ? row.text.slice(1) : row.text)), [rows])
  const [highlighted, setHighlighted] = useState<{ source: string[], lines: string[] } | null>(null)
  const diffWindow = useVirtualWindow<HTMLDivElement>(rows.length, ROW_HEIGHT)

  useEffect(() => {
    let cancelled = false
    highlightCode(`${texts.join('\n')}\n`, path)
      .then((lines) => {
        if (!cancelled) setHighlighted({ source: texts, lines })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [texts, path])

  const html = highlighted?.source === texts && highlighted.lines.length === texts.length ? highlighted.lines : null
  const added = rows.filter((row) => row.kind === 'addition').length
  const removed = rows.filter((row) => row.kind === 'deletion').length

  return <div className="code-diff-view">
    <p className="code-diff-summary">
      <span className="is-added">+{added}</span>
      <span className="is-removed">−{removed}</span>
    </p>
    <div className="code-diff" ref={diffWindow.ref}>
      <div className="code-lines" style={{ paddingTop: diffWindow.before, paddingBottom: diffWindow.after }}>
        {rows.slice(diffWindow.start, diffWindow.end).map((row, offset) => {
          const index = diffWindow.start + offset
          const content = isCodeLine(row) && html ? html[index] : escapeHtml(texts[index] ?? '')
          return <div key={index} className={`code-diff-line is-${row.kind}`}>
            <span className="code-diff-number">{row.oldLine ?? ''}</span>
            <span className="code-diff-number">{row.newLine ?? ''}</span>
            <span className="code-diff-sign">{row.kind === 'addition' ? '+' : row.kind === 'deletion' ? '−' : ''}</span>
            <span className="code-line-text" dangerouslySetInnerHTML={{ __html: content || ' ' }} />
          </div>
        })}
      </div>
    </div>
  </div>
}
