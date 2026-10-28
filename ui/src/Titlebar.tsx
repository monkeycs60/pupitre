import { useEffect, useState, type ReactNode } from 'react'
import { getCurrentWindow, type Window } from '@tauri-apps/api/window'
import type { InstanceHealth } from './types'
import { InstanceBadge } from './InstanceBadge'
import { Icon, type IconName } from './Icon'
import type { WorkspaceView } from './types'

type ResizeDirection = Parameters<Window['startResizeDragging']>[0]

/** La barre de titre s'affiche partout ; seuls les contrôles de fenêtre et le
 *  glisser-déplacer sont réservés à Tauri (nuls en dev navigateur). */
const IS_TAURI = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export interface TitlebarDestination {
  icon: IconName
  label: string
  view: WorkspaceView
  onClick: () => void
  shortcut?: string | null
}

interface TitlebarProps {
  /** Vue courante quand elle remplace les conversations (Rapport, Réglages…). */
  crumbs?: Array<string | null | undefined>
  instance?: InstanceHealth | null
  onRestart?: () => Promise<void>
  destinations?: TitlebarDestination[]
  workspaceView?: WorkspaceView
  /** Exécutions en cours et réponses à lire, au centre de la barre. */
  island?: ReactNode
  navigationOpen?: boolean
  onNavigationToggle?: () => void
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

export function Titlebar({
  crumbs,
  instance,
  onRestart,
  destinations = [],
  workspaceView,
  island,
  navigationOpen = false,
  onNavigationToggle,
}: TitlebarProps) {
  const visibleCrumbs = (crumbs ?? []).filter(
    (crumb): crumb is string => typeof crumb === 'string' && crumb.length > 0,
  )
  const drag = IS_TAURI ? { 'data-tauri-drag-region': true } : {}
  const showInstance = onRestart !== undefined && instance != null
    && (instance.instance !== 'stable' || instance.staleSources > 0)

  return (
    <header className="titlebar">
      <div className="titlebar-drag" {...drag}>
        {onNavigationToggle ? <button
          type="button"
          className="mobile-navigation-toggle titlebar-icon-button"
          aria-label="Projets et conversations"
          aria-expanded={navigationOpen}
          onClick={onNavigationToggle}
        ><Icon name={navigationOpen ? 'close' : 'folder'} /></button> : null}
        <span className="titlebar-app" {...drag}>
          <span className="titlebar-logo" aria-hidden="true"><i /></span>
          Pupitre
        </span>
        {visibleCrumbs.map((crumb, index) => (
          <span className="titlebar-crumb" key={`${index}-${crumb}`} {...drag}>{crumb}</span>
        ))}
      </div>

      <div className="titlebar-center" {...drag}>{island}</div>

      <div className="titlebar-right">
        {destinations.length > 0 ? (
          <nav className="titlebar-nav" aria-label="Navigation">
            {destinations.map((destination) => {
              const active = workspaceView === destination.view
              return (
                <button
                  key={destination.view}
                  type="button"
                  className={`titlebar-icon-button${active ? ' is-active' : ''}`}
                  onClick={destination.onClick}
                  title={destination.shortcut ? `${destination.label} · ${destination.shortcut}` : destination.label}
                  aria-label={destination.label}
                  aria-current={active ? 'page' : undefined}
                >
                  <Icon name={destination.icon} />
                </button>
              )
            })}
          </nav>
        ) : null}
        {showInstance ? <InstanceBadge health={instance} onRestart={onRestart} /> : null}
        {IS_TAURI ? (
          <div className="titlebar-controls">
            <button
              type="button"
              className="titlebar-button"
              aria-label="Réduire la fenêtre"
              onClick={() => void getCurrentWindow().minimize()}
            >
              <Icon name="minimize" size={14} />
            </button>
            <MaximizeButton />
            <button
              type="button"
              className="titlebar-button is-close"
              aria-label="Fermer la fenêtre"
              onClick={() => void getCurrentWindow().close()}
            >
              <Icon name="close" size={14} />
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
      <Icon name={isMaximized ? 'restore' : 'maximize'} size={14} />
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
