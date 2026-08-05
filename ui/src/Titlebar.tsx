import { useEffect, useState } from 'react'
import { getCurrentWindow, type Window } from '@tauri-apps/api/window'

type ResizeDirection = Parameters<Window['startResizeDragging']>[0]

/** La barre n'existe que sous Tauri : en dev navigateur, l'app reste nue. */
const IS_TAURI = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

interface TitlebarProps {
  /** Fil d'Ariane discret (projet · vue) ; les entrées vides sont ignorées. */
  crumbs?: Array<string | null | undefined>
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

export function Titlebar({ crumbs }: TitlebarProps) {
  if (!IS_TAURI) return null
  return <TauriTitlebar crumbs={crumbs} />
}

function TauriTitlebar({ crumbs }: TitlebarProps) {
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

  const visibleCrumbs = (crumbs ?? []).filter(
    (crumb): crumb is string => typeof crumb === 'string' && crumb.length > 0,
  )

  return (
    <header className="titlebar">
      <div className="titlebar-drag" data-tauri-drag-region>
        <span className="titlebar-app" data-tauri-drag-region>
          Pupitre
        </span>
        {visibleCrumbs.length > 0 ? (
          <span className="titlebar-crumbs" data-tauri-drag-region>
            {visibleCrumbs.map((crumb, index) => (
              <span className="titlebar-crumbs" key={`${index}-${crumb}`} data-tauri-drag-region>
                <span aria-hidden="true" data-tauri-drag-region>
                  ·
                </span>
                <span className="titlebar-crumb" data-tauri-drag-region>
                  {crumb}
                </span>
              </span>
            ))}
          </span>
        ) : null}
      </div>

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
        <button
          type="button"
          className="titlebar-button"
          aria-label={isMaximized ? 'Restaurer la fenêtre' : 'Agrandir la fenêtre'}
          onClick={() => void getCurrentWindow().toggleMaximize()}
        >
          {isMaximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path
                d="M3 3V1.5h5.5V7H7"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.1"
              />
              <rect
                x="1.5"
                y="3"
                width="5.5"
                height="5.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.1"
              />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect
                x="1.5"
                y="1.5"
                width="7"
                height="7"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.1"
              />
            </svg>
          )}
        </button>
        <button
          type="button"
          className="titlebar-button is-close"
          aria-label="Fermer la fenêtre"
          onClick={() => void getCurrentWindow().close()}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path
              d="M1.5 1.5l7 7M8.5 1.5l-7 7"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.1"
            />
          </svg>
        </button>
      </div>

      {!isMaximized
        ? RESIZE_HANDLES.map(([position, direction]) => (
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
          ))
        : null}
    </header>
  )
}
