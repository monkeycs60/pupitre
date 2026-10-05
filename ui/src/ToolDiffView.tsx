import { useContext, useEffect, useMemo, useState } from 'react'
import { escapeHtml, highlightCode } from './codeHighlight'
import { changedRange, dedented, locatedInFile, type ToolDiffFile, type ToolDiffLine } from './toolDiff'
import { ToolFileContext } from './toolFiles'

const HEAD_LINES = 40
const WORD_MARK = '<mark class="tool-diff-word">'

function markRange(html: string, [start, end]: [number, number]): string {
  if (start >= end) return html
  let out = ''
  let position = 0
  let open = false
  for (const [token] of html.matchAll(/<[^>]+>|&[#\w]+;|[^<&]/g)) {
    if (token.startsWith('<')) {
      out += open ? `</mark>${token}${WORD_MARK}` : token
      continue
    }
    if (position === start) {
      out += WORD_MARK
      open = true
    }
    out += token
    position += 1
    if (position === end && open) {
      out += '</mark>'
      open = false
    }
  }
  return open ? `${out}</mark>` : out
}

function wordRanges(lines: ToolDiffLine[]): Map<number, [number, number]> {
  const ranges = new Map<number, [number, number]>()
  let index = 0
  while (index < lines.length) {
    if (lines[index].kind !== 'removed') {
      index += 1
      continue
    }
    const removedStart = index
    while (index < lines.length && lines[index].kind === 'removed') index += 1
    const addedStart = index
    while (index < lines.length && lines[index].kind === 'added') index += 1
    const pairs = Math.min(addedStart - removedStart, index - addedStart)
    for (let offset = 0; offset < pairs; offset += 1) {
      const range = changedRange(lines[removedStart + offset].text, lines[addedStart + offset].text)
      if (!range) continue
      ranges.set(removedStart + offset, range.before)
      ranges.set(addedStart + offset, range.after)
    }
  }
  return ranges
}

function DiffFile({ file: rawFile }: { file: ToolDiffFile }) {
  const access = useContext(ToolFileContext)
  const [full, setFull] = useState(false)
  const [located, setLocated] = useState<ToolDiffFile | null>(null)
  const [unreachable, setUnreachable] = useState(false)
  const absolute = rawFile.path.startsWith('/')

  useEffect(() => {
    if (!access || !absolute || !rawFile.replaced) return
    let cancelled = false
    access.readFile(rawFile.path)
      .then((content) => {
        if (!cancelled && content !== null) setLocated(locatedInFile(rawFile, content))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [access, absolute, rawFile])

  const file = useMemo(() => dedented(located ?? rawFile), [located, rawFile])
  const texts = useMemo(() => file.lines.map((line) => (line.kind === 'gap' ? '' : line.text)), [file])
  const ranges = useMemo(() => wordRanges(file.lines), [file])
  const [highlighted, setHighlighted] = useState<{ source: string[]; lines: string[] } | null>(null)

  useEffect(() => {
    let cancelled = false
    highlightCode(`${texts.join('\n')}\n`, file.path)
      .then((lines) => {
        if (!cancelled) setHighlighted({ source: texts, lines })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [texts, file.path])

  const html = highlighted?.source === texts && highlighted.lines.length === texts.length ? highlighted.lines : null
  const added = file.lines.filter((line) => line.kind === 'added').length
  const removed = file.lines.filter((line) => line.kind === 'removed').length
  const hidden = full ? 0 : Math.max(0, file.lines.length - HEAD_LINES)
  const numbered = file.lines.some((line) => line.line !== undefined)
  const segments = file.path.split('/').filter(Boolean)
  const name = segments.at(-1) ?? file.path
  const folder = segments.slice(-3, -1).join('/')

  return (
    <section className="tool-diff-file">
      <header className="tool-diff-header">
        <span className="tool-diff-path" title={file.path}>
          {folder ? <span className="tool-diff-folder">{folder}/</span> : null}
          {name}
        </span>
        {file.status !== 'modified' ? (
          <span className={`tool-diff-status is-${file.status}`}>{file.status === 'added' ? 'nouveau' : 'supprimé'}</span>
        ) : null}
        {access && absolute ? (
          <button
            type="button"
            className="tool-diff-open"
            disabled={unreachable}
            title={unreachable ? 'Fichier hors des dépôts du projet' : 'Ouvrir dans l’onglet Code'}
            onClick={() => {
              const firstLine = file.lines.find((line) => (line.kind === 'added' || line.kind === 'removed') && line.line !== undefined)?.line ?? null
              void access.openInCode(rawFile.path, firstLine).then((opened) => setUnreachable(!opened))
            }}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M6 4 2 8l4 4M10 4l4 4-4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Ouvrir
          </button>
        ) : null}
        <span className="tool-diff-stats">
          {added > 0 ? <span className="is-added">+{added}</span> : null}
          {removed > 0 ? <span className="is-removed">−{removed}</span> : null}
        </span>
      </header>
      <div className={`tool-diff-body${numbered ? ' is-numbered' : ''}`}>
        {file.lines.slice(0, file.lines.length - hidden).map((line, index) => {
          if (line.kind === 'gap') {
            return <div key={index} className="tool-diff-gap">{line.text || '⋯'}</div>
          }
          const base = html?.[index] ?? escapeHtml(line.text)
          const range = ranges.get(index)
          return (
            <div key={index} className={`tool-diff-row is-${line.kind}`}>
              {numbered ? <span className="tool-diff-number">{line.line ?? ''}</span> : null}
              <span className="tool-diff-sign">{line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ''}</span>
              <code dangerouslySetInnerHTML={{ __html: (range ? markRange(base, range) : base) || ' ' }} />
            </div>
          )
        })}
      </div>
      {hidden > 0 ? (
        <button type="button" className="tool-diff-more" onClick={() => setFull(true)}>
          Afficher {hidden} ligne{hidden > 1 ? 's' : ''} de plus
        </button>
      ) : null}
    </section>
  )
}

export function ToolDiffView({ files }: { files: ToolDiffFile[] }) {
  return (
    <div className="tool-diff">
      {files.map((file, index) => <DiffFile key={`${file.path}-${index}`} file={file} />)}
    </div>
  )
}
