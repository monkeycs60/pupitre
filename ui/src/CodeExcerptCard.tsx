import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import type { CodeExcerptBlock } from './groupEvents'
import { FileTypeIcon } from './FileTypeIcon'
import { highlightCode, languageForPath, plainCodeLines, splitCodeLines } from './codeHighlight'
import { useVirtualWindow } from './useVirtualWindow'
import Markdown from './Markdown'
import { FILE_CITATION_HINT, openFileTarget, useFileCitation } from './FileCitation'
import './styles/code-excerpt.css'

const LINE_HEIGHT = 22

export function CodeExcerptCard({ block }: { block: CodeExcerptBlock }) {
  const plain = useMemo(() => plainCodeLines(block.content), [block.content])
  const [highlighted, setHighlighted] = useState<string[] | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [copyState, setCopyState] = useState('Copier le passage')
  const window = useVirtualWindow<HTMLDivElement>(plain.length, LINE_HEIGHT, 8)
  const { element } = window
  const visibleLines = Math.min(18, Math.max(6, block.endLine - block.startLine + 5))
  const height = expanded ? 550 : visibleLines * LINE_HEIGHT
  const pathParts = block.path.split('/')
  const name = pathParts.pop()
  const directory = pathParts.join('/')
  const { access, resolution } = useFileCitation(`./${block.path}`)
  const range = block.startLine === block.endLine ? `L${block.startLine}` : `L${block.startLine}–${block.endLine}`

  useEffect(() => {
    let cancelled = false
    void highlightCode(block.content, block.path).then((lines) => {
      if (!cancelled) setHighlighted(lines)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [block.content, block.path])

  useLayoutEffect(() => {
    if (!element) return
    element.scrollTop = Math.max(0, block.startLine - 3) * LINE_HEIGHT
    element.dispatchEvent(new Event('scroll'))
  }, [element, block.startLine])

  function focusPassage() {
    if (element) element.scrollTop = Math.max(0, block.startLine - 3) * LINE_HEIGHT
    element?.dispatchEvent(new Event('scroll'))
  }

  async function copyPassage() {
    try {
      await navigator.clipboard.writeText(splitCodeLines(block.content).slice(block.startLine - 1, block.endLine).join('\n'))
      setCopyState('Passage copié')
    } catch {
      setCopyState('Copie impossible')
    }
  }

  const lines = highlighted?.length === plain.length ? highlighted : plain
  return <article className="code-excerpt" aria-label={`${block.path}, ${range}`}>
    <header className="code-excerpt-header">
      <div className="code-excerpt-file" title={block.path}>
        <FileTypeIcon path={block.path} />
        {access !== null && resolution?.status === 'resolved' ? (
          <a
            className="code-excerpt-open"
            href="#"
            title={`${resolution.label}:${block.startLine}\n${FILE_CITATION_HINT}`}
            onClick={(event) => openFileTarget(access, event, resolution.path, block.startLine)}
          >
            <strong>{name}</strong>{directory && <span>{directory}/</span>}
          </a>
        ) : <div><strong>{name}</strong>{directory && <span>{directory}/</span>}</div>}
      </div>
      <div className="code-excerpt-actions">
        <button type="button" className="code-excerpt-focus" onClick={focusPassage} title="Revenir au passage cité">{range} <span aria-hidden="true">↗</span></button>
        <button type="button" onClick={() => { setExpanded(!expanded) }} aria-expanded={expanded}>{expanded ? 'Réduire' : 'Agrandir'}</button>
        <button type="button" onClick={() => { void copyPassage() }}>{copyState}</button>
      </div>
    </header>
    <div className="code-excerpt-viewport" ref={window.ref} style={{ height, maxHeight: '65vh' }} tabIndex={0} role="region" aria-label={`Code de ${block.path}, fichier défilable`}>
      <div className="code-excerpt-lines">
        <div style={{ height: window.before }} aria-hidden="true" />
        {lines.slice(window.start, window.end).map((html, offset) => {
          const line = window.start + offset + 1
          const selected = block.highlights.some((item) => line >= item.startLine && line <= item.endLine)
          return <div key={line} className={`code-excerpt-line${selected ? ' is-highlighted' : ''}`} data-line={line} data-highlighted={selected || undefined}>
            <span className="code-excerpt-number" aria-hidden="true">{line}</span>
            <code dangerouslySetInnerHTML={{ __html: html || ' ' }} />
          </div>
        })}
        <div style={{ height: window.after }} aria-hidden="true" />
      </div>
    </div>
    <footer className="code-excerpt-meta">
      <span>{plain.length} lignes · {languageForPath(block.path) ?? 'texte'}</span>
      <span title={`Copie du ${new Date(block.createdAt).toLocaleString('fr-FR')} · SHA-256 ${block.sha256}`}>Version citée · {block.sha256.slice(0, 7)}</span>
    </footer>
    <div className="code-excerpt-explanation">
      <h3>{block.title}</h3>
      <Markdown>{block.explanation}</Markdown>
    </div>
  </article>
}
