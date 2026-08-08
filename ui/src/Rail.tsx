import { useEffect, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { createProject, listProjects } from './api'
import type { Project, WorkspaceView } from './types'

/** Rail vertical (56 px) : bascule de projet + navigation globale.
 *  Remplace la liste de projets et le tiroir « Outils » de l'ancienne sidebar. */

interface RailProps {
  selectedProject: Project | null
  projectListVersion: number
  onProjectSelect: (project: Project) => void
  onProjectCreated: (project: Project) => void
  workspaceView: WorkspaceView
  onGitSelect: () => void
  onCostsSelect: () => void
  onLibrarySelect: () => void
  onRoutinesSelect: () => void
  onFleetSelect: () => void
  onMemorySelect: () => void
  onHelpSelect: () => void
  onProgressSelect: () => void
  onSettingsSelect: () => void
  pendingReviews?: number
  /** Runs actifs (tours + sub-agents + routines), pour la pastille Fleet. */
  fleetActive?: number
}

type NavName =
  | 'fleet'
  | 'git'
  | 'progress'
  | 'costs'
  | 'library'
  | 'memory'
  | 'routines'
  | 'help'
  | 'settings'

const NAV_PATHS: Record<NavName, React.ReactNode> = {
  fleet: <path d="M2 8h3l1.5-4L9 12l1.5-4H14" />,
  git: (
    <>
      <circle cx="5" cy="4" r="1.5" />
      <circle cx="11" cy="12" r="1.5" />
      <circle cx="5" cy="12" r="1.5" />
      <path d="M5 5.5v5M6.5 4H8a3 3 0 0 1 3 3v3.5" />
    </>
  ),
  progress: (
    <>
      <path d="M3 13V8M8 13V5M13 13V2" />
      <path d="M2 13.5h12" />
    </>
  ),
  costs: (
    <>
      <path d="M3 13V8M8 13V3M13 13V6" />
      <path d="M2 13.5h12" />
    </>
  ),
  library: <path d="M3 3v10M6 3v10M10 3.5l2 9.5M2 13h12" />,
  memory: (
    <>
      <path d="M4 2.5h6l2 2V14H4Z" />
      <path d="M10 2.5V5h2M6 8h4M6 10.5h4" />
    </>
  ),
  routines: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3l2 1.5" />
    </>
  ),
  help: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M6.5 6.2A1.7 1.7 0 0 1 8.2 5c1 0 1.8.6 1.8 1.5 0 1.7-2 1.5-2 3M8 11.8v.2" />
    </>
  ),
  settings: (
    <>
      <circle cx="8" cy="8" r="2" />
      <path d="M6.5 2h3l.5 2a4.5 4.5 0 0 1 1.3.8l1.9-.7 1.5 2.6-1.5 1.3a5 5 0 0 1 0 1.6l1.5 1.3-1.5 2.6-1.9-.7a4.5 4.5 0 0 1-1.3.8l-.5 2h-3l-.5-2a4.5 4.5 0 0 1-1.3-.8l-1.9.7-1.5-2.6 1.5-1.3a5 5 0 0 1 0-1.6L1.3 6.7l1.5-2.6 1.9.7A4.5 4.5 0 0 1 6 4l.5-2Z" />
    </>
  ),
}

function RailIcon({ name }: { name: NavName }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.3">
        {NAV_PATHS[name]}
      </g>
    </svg>
  )
}

function projectInitials(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9]+/g, ' ').trim()
  if (!cleaned) return '··'
  const parts = cleaned.split(/\s+/)
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase()
  return cleaned.slice(0, 2).toUpperCase()
}

function pinnedFirst<T extends { pinned: boolean }>(items: T[]): T[] {
  return [...items].sort((left, right) => Number(right.pinned) - Number(left.pinned))
}

function pathBasename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  return trimmed.split(/[\\/]/).pop() || path
}

export function Rail({
  selectedProject,
  projectListVersion,
  onProjectSelect,
  onProjectCreated,
  workspaceView,
  onGitSelect,
  onCostsSelect,
  onLibrarySelect,
  onRoutinesSelect,
  onFleetSelect,
  onMemorySelect,
  onHelpSelect,
  onProgressSelect,
  onSettingsSelect,
  pendingReviews = 0,
  fleetActive = 0,
}: RailProps) {
  const [projects, setProjects] = useState<Project[]>([])

  useEffect(() => {
    let ignore = false
    void listProjects()
      .then((items) => {
        if (!ignore) setProjects(pinnedFirst(items))
      })
      .catch(() => {})
    return () => {
      ignore = true
    }
  }, [projectListVersion])

  async function handleAddProject() {
    if (!window.__TAURI__) return
    try {
      const selectedPath = await open({ directory: true })
      if (typeof selectedPath !== 'string') return
      const project = await createProject({ name: pathBasename(selectedPath), path: selectedPath })
      setProjects((current) => pinnedFirst([project, ...current]))
      onProjectCreated(project)
    } catch {
      // Dialog annulée ou création refusée : rien à afficher dans le rail.
    }
  }

  const nav: Array<{
    name: NavName
    label: string
    view: WorkspaceView
    onClick: () => void
    needsProject?: boolean
    badge?: number
  }> = [
    { name: 'fleet', label: 'Fleet', view: 'fleet', onClick: onFleetSelect, badge: fleetActive },
    { name: 'git', label: 'Git', view: 'git', onClick: onGitSelect, needsProject: true, badge: pendingReviews },
    { name: 'progress', label: 'Progression', view: 'progress', onClick: onProgressSelect },
    { name: 'costs', label: 'Coûts & quotas', view: 'costs', onClick: onCostsSelect, needsProject: true },
    { name: 'library', label: 'Bibliothèque', view: 'library', onClick: onLibrarySelect },
    { name: 'memory', label: 'Mémoire', view: 'memory', onClick: onMemorySelect },
    { name: 'routines', label: 'Routines', view: 'routines', onClick: onRoutinesSelect },
    { name: 'help', label: 'Aide', view: 'help', onClick: onHelpSelect },
    { name: 'settings', label: 'Réglages', view: 'settings', onClick: onSettingsSelect },
  ]

  return (
    <nav className="rail" aria-label="Projets et navigation">
      <div className="rail-projects">
        {projects.map((project) => {
          const active = selectedProject?.id === project.id && workspaceView === 'conversations'
          const current = selectedProject?.id === project.id
          return (
            <div className="rail-project" key={project.id}>
              <span className={`rail-project-bar ${active ? 'is-active' : ''}`} aria-hidden="true" />
              <button
                type="button"
                className={`rail-avatar ${current ? 'is-current' : ''}`}
                onClick={() => onProjectSelect(project)}
                title={project.name}
                aria-current={current ? 'true' : undefined}
              >
                {projectInitials(project.name)}
              </button>
            </div>
          )
        })}
        {window.__TAURI__ ? (
          <button
            type="button"
            className="rail-add"
            onClick={() => void handleAddProject()}
            title="Ajouter un projet"
            aria-label="Ajouter un projet"
          >
            +
          </button>
        ) : null}
      </div>

      <div className="rail-spacer" />
      <div className="rail-divider" aria-hidden="true" />

      <div className="rail-nav">
        {nav.map((item) => (
          <button
            type="button"
            key={item.name}
            className={`rail-nav-button ${workspaceView === item.view ? 'is-active' : ''}`}
            onClick={item.onClick}
            disabled={item.needsProject && selectedProject === null}
            title={item.label}
            aria-label={item.label}
            aria-current={workspaceView === item.view ? 'true' : undefined}
          >
            <RailIcon name={item.name} />
            {item.badge && item.badge > 0 ? (
              <span
                className={`rail-badge ${item.name === 'fleet' ? 'is-live' : ''}`}
                aria-hidden="true"
              />
            ) : null}
          </button>
        ))}
      </div>
    </nav>
  )
}
