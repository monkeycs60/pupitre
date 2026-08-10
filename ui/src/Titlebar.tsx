import { useEffect, useState } from 'react'
import { getCurrentWindow, type Window } from '@tauri-apps/api/window'
import type { GamificationSnapshot } from './types'
import { formatActiveDuration } from './formatActiveDuration'

type ResizeDirection = Parameters<Window['startResizeDragging']>[0]

/** La barre de titre s'affiche partout ; seuls les contrôles de fenêtre et le
 *  glisser-déplacer sont réservés à Tauri (nuls en dev navigateur). */
const IS_TAURI = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

interface TitlebarProps {
  /** Fil d'Ariane discret (projet · vue) ; les entrées vides sont ignorées. */
  crumbs?: Array<string | null | undefined>
  onSearch?: () => void
  gamification?: GamificationSnapshot | null
}

const RESIZE_HANDLES: ReadonlyArray<[string, ResizeDirection]> = [
  ['edge-n', 'North'],
  ['edge-s', 'South'],
  ['edge-e', 'East'],
  ['edge-w', 'West'],
  ['corner-nw', 'NorthWest'],
  ['corner-ne', 'NorthEast'],
  ['corner-sw', 'SouthWest'],
  ['corner-se', 'SouthEast'],
]

const FLAME_PATH =
  'M8 13.6c2.6 0 4.3-1.7 4.3-4 0-2.5-1.9-3.9-2.7-6.1-1.2 1-1.9 2.1-1.9 3.3 0 .9.4 1.4.4 2 0 .8-.5 1.3-1.2 1.3-.9 0-1.4-.8-1.4-1.9-.9.9-1.2 2-1.2 3.2 0 2.2 1.4 4.2 3.7 4.2Z'

function activeLabel(snapshot: GamificationSnapshot | null | undefined): string | null {
  if (!snapshot) return null
  const minutes = Math.floor(snapshot.activeMsToday / 60_000)
  if (minutes < 1) return null
  return formatActiveDuration(snapshot.activeMsToday)
}

export function Titlebar({ crumbs, onSearch, gamification }: TitlebarProps) {
  const visibleCrumbs = (crumbs ?? []).filter(
    (crumb): crumb is string => typeof crumb === 'string' && crumb.length > 0,
  )
  const activity = activeLabel(gamification)

  const drag = IS_TAURI ? { 'data-tauri-drag-region': true } : {}

  return (
    <header className="titlebar">
      <div className="titlebar-drag" {...drag}>
        <span className="titlebar-app" {...drag}>
          Pupitre
        </span>
        {visibleCrumbs.length > 0 ? (
          <span className="titlebar-crumbs" {...drag}>
            {visibleCrumbs.map((crumb, index) => (
              <span className="titlebar-crumbs" key={`${index}-${crumb}`} {...drag}>
                <span aria-hidden="true" {...drag}>
                  /
                </span>
                <span className="titlebar-crumb" {...drag}>
                  {crumb}
                </span>
              </span>
            ))}
          </span>
        ) : null}
        {onSearch ? (
          <button type="button" className="titlebar-search" onClick={onSearch}>
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                <circle cx="7" cy="7" r="4.2" />
                <path d="m10.2 10.2 3 3" />
              </g>
            </svg>
            <span>Rechercher partout</span>
            <kbd>Ctrl K</kbd>
          </button>
        ) : null}
      </div>

      <div className="titlebar-right">
        {activity ? (
          <span className="titlebar-streak" title="Temps actif aujourd'hui">
            <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
              <path d={FLAME_PATH} fill="currentColor" />
            </svg>
            <span>{activity}</span>
          </span>
        ) : null}

        {IS_TAURI ? (
          <div className="titlebar-controls">
            <button
              type="button"
              className="titlebar-button"
              aria-label="Réduire la fenêtre"
              onClick={() => void getCurrentWindow().minimize()}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <path d="M1 5.5h8" fill="none" stroke="currentColor" strokeWidth="1.1" />
              </svg>
            </button>
            <MaximizeButton />
            <button
              type="button"
              className="titlebar-button is-close"
              aria-label="Fermer la fenêtre"
              onClick={() => void getCurrentWindow().close()}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" fill="none" stroke="currentColor" strokeWidth="1.1" />
              </svg>
            </button>
          </div>
        ) : null}
      </div>

      {IS_TAURI ? <ResizeHandles /> : null}
    </header>
  )
}

function MaximizeButton() {
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    const appWindow = getCurrentWindow()
    let disposed = false
    function refresh() {
      void appWindow.isMaximized().then((maximized) => {
        if (!disposed) setIsMaximized(maximized)
      })
    }
    refresh()
    const unlistenPromise = appWindow.onResized(refresh)
    return () => {
      disposed = true
      void unlistenPromise.then((unlisten) => unlisten())
    }
  }, [])

  return (
    <button
      type="button"
      className="titlebar-button"
      aria-label={isMaximized ? 'Restaurer la fenêtre' : 'Agrandir la fenêtre'}
      onClick={() => void getCurrentWindow().toggleMaximize()}
    >
      {isMaximized ? (
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M3 3V1.5h5.5V7H7" fill="none" stroke="currentColor" strokeWidth="1.1" />
          <rect x="1.5" y="3" width="5.5" height="5.5" fill="none" stroke="currentColor" strokeWidth="1.1" />
        </svg>
      ) : (
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <rect x="1.5" y="1.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1.1" />
        </svg>
      )}
    </button>
  )
}

function ResizeHandles() {
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    const appWindow = getCurrentWindow()
    let disposed = false
    function refresh() {
      void appWindow.isMaximized().then((maximized) => {
        if (!disposed) setIsMaximized(maximized)
      })
    }
    refresh()
    const unlistenPromise = appWindow.onResized(refresh)
    return () => {
      disposed = true
      void unlistenPromise.then((unlisten) => unlisten())
    }
  }, [])

  if (isMaximized) return null
  return (
    <>
      {RESIZE_HANDLES.map(([position, direction]) => (
        <div
          key={position}
          className={`resize-handle ${position}`}
          aria-hidden="true"
          onMouseDown={(event) => {
            if (event.button !== 0) return
            event.preventDefault()
            void getCurrentWindow().startResizeDragging(direction)
          }}
        />
      ))}
    </>
  )
}
