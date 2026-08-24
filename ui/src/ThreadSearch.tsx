import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, RefObject } from 'react'
import { clearMatches, collectMatches, paintMatches, scrollToMatch } from './threadSearchCore'

/**
 * Barre de recherche flottante du fil (Ctrl F ou la loupe) : occurrences
 * surlignées dans le texte, la courante en accent, navigation ↑↓ / ⏎.
 */
export function ThreadSearch({ viewportRef, open, onOpen, onClose, contentVersion }: {
  viewportRef: RefObject<HTMLDivElement | null>
  open: boolean
  onOpen: () => void
  onClose: () => void
  /** Change avec le contenu du fil : les Ranges se recalculent. */
  contentVersion: number
}) {
  const [query, setQuery] = useState('')
  const [currentIndex, setCurrentIndex] = useState(0)
  const [matchCount, setMatchCount] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const rangesRef = useRef<Range[]>([])
  /** Vrai juste après une navigation : le repaint ne doit pas re-centrer. */
  const scrollPendingRef = useRef(false)

  useEffect(() => {
    if (open) inputRef.current?.focus()
    else {
      setQuery('')
      setCurrentIndex(0)
      setMatchCount(0)
      rangesRef.current = []
      clearMatches()
    }
  }, [open])

  useEffect(() => () => clearMatches(), [])

  useEffect(() => {
    if (!open) return
    const viewport = viewportRef.current
    if (viewport === null) return
    // Petit débounce : la frappe et le streaming re-déclenchent la collecte.
    const timer = setTimeout(() => {
      const ranges = collectMatches(viewport, query)
      rangesRef.current = ranges
      setMatchCount(ranges.length)
      const boundedIndex = ranges.length === 0 ? 0 : Math.min(currentIndex, ranges.length - 1)
      if (boundedIndex !== currentIndex) setCurrentIndex(boundedIndex)
      paintMatches(ranges, boundedIndex)
      if (scrollPendingRef.current) {
        scrollPendingRef.current = false
        const current = ranges[boundedIndex]
        if (current !== undefined) scrollToMatch(viewport, current)
      }
    }, 120)
    return () => clearTimeout(timer)
  }, [open, query, currentIndex, contentVersion, viewportRef])

  function step(delta: number) {
    const count = rangesRef.current.length
    if (count === 0) return
    scrollPendingRef.current = true
    setCurrentIndex((current) => (current + delta + count) % count)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault()
      step(event.shiftKey ? -1 : 1)
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      step(1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      step(-1)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        className="thread-search-open"
        onClick={onOpen}
        title="Rechercher dans le fil (Ctrl F)"
        aria-label="Rechercher dans le fil"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
            <circle cx="7" cy="7" r="4.2" />
            <path d="m10.2 10.2 3 3" />
          </g>
        </svg>
      </button>
    )
  }

  return (
    <div className="thread-search" role="search" aria-label="Recherche dans le fil">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
          <circle cx="7" cy="7" r="4.2" />
          <path d="m10.2 10.2 3 3" />
        </g>
      </svg>
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          setCurrentIndex(0)
        }}
        onKeyDown={handleKeyDown}
        placeholder="Rechercher…"
        aria-label="Texte à rechercher"
      />
      <span className="thread-search-count" aria-live="polite">
        {matchCount === 0 ? '0/0' : `${currentIndex + 1}/${matchCount}`}
      </span>
      <span className="thread-search-divider" aria-hidden="true" />
      <button type="button" className="thread-search-nav" onClick={() => step(-1)} disabled={matchCount === 0} title="Occurrence précédente (Maj ⏎)" aria-label="Occurrence précédente">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 10l4-4 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      <button type="button" className="thread-search-nav" onClick={() => step(1)} disabled={matchCount === 0} title="Occurrence suivante (⏎)" aria-label="Occurrence suivante">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      <button type="button" className="thread-search-nav" onClick={onClose} title="Fermer (Échap)" aria-label="Fermer la recherche">×</button>
    </div>
  )
}
