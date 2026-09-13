import { useEffect, useRef, useState, type ReactNode } from 'react'

export type InspectorView = 'dashboard' | 'attention' | 'fleet' | 'library' | 'memory' | 'routines' | 'workflows' | 'costs' | 'quotas' | 'progress'
export const INSPECTOR_GROUPS = [
  { title: 'Projet', needsProject: true, tabs: [['dashboard', 'Suivi du projet']] },
  { title: 'Activité', needsProject: false, tabs: [['attention', 'À traiter'], ['fleet', 'Exécutions']] },
  { title: 'Contexte', needsProject: false, tabs: [['library', 'Skills'], ['memory', 'Mémoire']] },
  { title: 'Automatisations', needsProject: true, tabs: [['workflows', 'À la demande'], ['routines', 'Planifiées']] },
  { title: 'Utilisation', needsProject: false, tabs: [['quotas', 'Quotas du compte'], ['costs', 'Coûts du projet'], ['progress', 'Progression']] },
] as const
export type InspectorGroup = (typeof INSPECTOR_GROUPS)[number]

export function inspectorGroupOf(view: InspectorView): InspectorGroup {
  return INSPECTOR_GROUPS.find((group) => group.tabs.some(([id]) => id === view))!
}

const MIN_INSPECTOR_WIDTH = 280

/* Comme la sidebar, le panneau se borne à la fenêtre plutôt qu'à un palier
   fixe : sur un grand écran il peut couvrir la quasi-totalité de la surface. */
function maxInspectorWidth(viewport = window.innerWidth): number {
  return Math.max(MIN_INSPECTOR_WIDTH, Math.round(viewport * 0.9))
}

export function WorkspaceInspector({ view, onViewChange, onClose, title, children }: { view: InspectorView; onViewChange: (view: InspectorView) => void; onClose: () => void; title?: string; children: ReactNode }) {
  const [width, setWidth] = useState(() => {
    const stored = Number(localStorage.getItem('pupitre:inspector-width'))
    return Number.isFinite(stored) && stored >= MIN_INSPECTOR_WIDTH
      ? Math.min(stored, maxInspectorWidth())
      : 480
  })
  const closeRef = useRef<HTMLButtonElement>(null)
  const group = inspectorGroupOf(view)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [])
  function resize(value: number) {
    const next = Math.min(maxInspectorWidth(), Math.max(MIN_INSPECTOR_WIDTH, value))
    setWidth(next)
    localStorage.setItem('pupitre:inspector-width', String(next))
  }
  return <aside className="workspace-inspector" aria-label={group.title} style={{ width }} onKeyDown={(event) => {
    if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); onClose() }
  }}>
    <div className="inspector-resize" role="separator" aria-label="Redimensionner le panneau" aria-orientation="vertical" aria-valuenow={width} aria-valuemin={MIN_INSPECTOR_WIDTH} aria-valuemax={maxInspectorWidth()} tabIndex={0}
      onKeyDown={(event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); resize(width + (event.key === 'ArrowLeft' ? 32 : -32)) } }}
      onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); event.currentTarget.dataset.origin = String(event.clientX); event.currentTarget.dataset.width = String(width) }}
      onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) resize(Number(event.currentTarget.dataset.width) + Number(event.currentTarget.dataset.origin) - event.clientX) }}
      onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }} />
    <header className="inspector-header">
      <h2>{title ?? group.title}</h2>
      {group.tabs.length > 1 ? <div className="inspector-tabs" role="tablist" aria-label={group.title}>{group.tabs.map(([id, label]) => <button key={id} id={`inspector-tab-${id}`} type="button" role="tab" aria-selected={view === id} aria-controls="inspector-content" onClick={() => onViewChange(id)}>{label}</button>)}</div> : null}
      <button ref={closeRef} type="button" className="inspector-close" aria-label="Fermer le panneau" onClick={onClose}>×</button>
    </header>
    <div className="inspector-content" id="inspector-content" role={group.tabs.length > 1 ? 'tabpanel' : undefined} aria-labelledby={group.tabs.length > 1 ? `inspector-tab-${view}` : undefined}>{children}</div>
  </aside>
}
