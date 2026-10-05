import { useEffect, useRef, useState } from 'react'
import {
  READING_ZOOM_MAX,
  READING_ZOOM_MIN,
  setReadingWidth,
  setReadingZoom,
  stepReadingZoom,
  useReadingPrefs,
  type ReadingWidth,
} from './readingPrefs'

const WIDTHS: Array<[ReadingWidth, string]> = [
  ['narrow', 'Étroit'],
  ['normal', 'Normal'],
  ['wide', 'Large'],
]

export function ReadingControls() {
  const { zoom, width } = useReadingPrefs()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handlePointer(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', handlePointer)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('pointerdown', handlePointer)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open])

  return (
    <div className="reading-controls" ref={rootRef}>
      <button
        type="button"
        className={`header-action header-action-icon${open || zoom !== 1 ? ' is-active' : ''}`}
        onClick={() => setOpen(!open)}
        title="Lecture : taille du texte et largeur (Ctrl + / Ctrl −)"
        aria-label="Réglages de lecture"
        aria-expanded={open}
      >
        <span className="reading-controls-glyph" aria-hidden="true">A<small>a</small></span>
      </button>
      {open ? (
        <div className="reading-popover" role="dialog" aria-label="Réglages de lecture">
          <div className="reading-popover-row">
            <span className="reading-popover-label">Taille</span>
            <div className="reading-zoom-stepper">
              <button type="button" onClick={() => stepReadingZoom(-1)} disabled={zoom <= READING_ZOOM_MIN} aria-label="Réduire le texte">−</button>
              <button type="button" className="reading-zoom-value" onClick={() => setReadingZoom(1)} title="Revenir à 100 % (Ctrl 0)">
                {Math.round(zoom * 100)} %
              </button>
              <button type="button" onClick={() => stepReadingZoom(1)} disabled={zoom >= READING_ZOOM_MAX} aria-label="Agrandir le texte">+</button>
            </div>
          </div>
          <div className="reading-popover-row">
            <span className="reading-popover-label">Largeur</span>
            <div className="reading-width-seg" role="radiogroup" aria-label="Largeur de lecture">
              {WIDTHS.map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={width === value}
                  className={width === value ? 'is-active' : undefined}
                  onClick={() => setReadingWidth(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <p className="reading-popover-hint">Ctrl + molette ou Ctrl + / − / 0 dans le fil</p>
        </div>
      ) : null}
    </div>
  )
}
