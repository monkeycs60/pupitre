import { track } from './analytics'
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

export function ReadingSettings() {
  const { zoom, width } = useReadingPrefs()
  return (
    <div className="reading-settings">
      <div className="reading-settings-row">
        <div>
          <strong>Taille du texte</strong>
          <span>Ctrl + et Ctrl − partout, Ctrl 0 pour revenir à 100 %</span>
        </div>
        <div className="reading-zoom-stepper">
          <button type="button" onClick={() => { track('settings.text-size', { sens: 'moins' }); stepReadingZoom(-1) }} disabled={zoom <= READING_ZOOM_MIN} aria-label="Réduire le texte">−</button>
          <button type="button" className="reading-zoom-value" onClick={() => setReadingZoom(1)} title="Revenir à 100 %">
            {Math.round(zoom * 100)} %
          </button>
          <button type="button" onClick={() => { track('settings.text-size', { sens: 'plus' }); stepReadingZoom(1) }} disabled={zoom >= READING_ZOOM_MAX} aria-label="Agrandir le texte">+</button>
        </div>
      </div>
      <div className="reading-settings-row">
        <div>
          <strong>Largeur de lecture</strong>
          <span>Largeur maximale du fil de conversation</span>
        </div>
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
    </div>
  )
}
