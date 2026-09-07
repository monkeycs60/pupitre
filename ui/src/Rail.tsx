import { memo, useEffect, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { createProject, getUnreadConversationCounts, listProjects } from './api'
import type { Project, WorkspaceView } from './types'
import { retryUntilAvailable } from './startupRetry'
import { projectInitials } from './projectInitials'

/** Rail vertical (56 px) : bascule de projet. Les destinations globales
 *  vivent dans la barre de titre. */

interface RailProps {
  selectedProject: Project | null
  projectListVersion: number
  conversationListVersion?: number
  onProjectSelect: (project: Project) => void
  onProjectCreated: (project: Project) => void
  workspaceView: WorkspaceView
  /** Projets ayant au moins un run actif dans Fleet. */
  activeProjectIds?: string[]
}

function pinnedFirst<T extends { pinned: boolean }>(items: T[]): T[] {
  return [...items].sort((left, right) => Number(right.pinned) - Number(left.pinned))
}

function pathBasename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  return trimmed.split(/[\\/]/).pop() || path
}

export const Rail = memo(function Rail({
  selectedProject,
  projectListVersion,
  conversationListVersion = 0,
  onProjectSelect,
  onProjectCreated,
  workspaceView,
  activeProjectIds = [],
}: RailProps) {
  const [projects, setProjects] = useState<Project[]>([])
  const [unreadByProject, setUnreadByProject] = useState<Record<string, number>>({})
  const [isLabelExpanded, setIsLabelExpanded] = useState(false)
  /** Dans la vue Claude Design, le rail reste déplié et occupe réellement sa
   *  colonne au lieu de déborder au survol. Le panneau y est une webview, une
   *  surface du système qui se dessine au-dessus du DOM : un rail débordant
   *  passerait derrière elle et s'afficherait tronqué. Voir
   *  `.app-shell--pinned-rail` dans `styles/shell.css`. */
  const isRailPinned = workspaceView === 'design'

  useEffect(() => {
    let ignore = false
    void retryUntilAvailable(
      () => listProjects(),
      { cancelled: () => ignore },
    )
      .then((items) => {
        if (ignore || items === null) return
        const ordered = pinnedFirst(items)
        setProjects(ordered)
        void getUnreadConversationCounts().then((counts) => {
          if (!ignore) setUnreadByProject(counts)
        }).catch(() => {})
      })
    return () => {
      ignore = true
    }
  }, [projectListVersion, conversationListVersion])

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

  return (
    <nav
      className={`rail${isLabelExpanded || isRailPinned ? ' is-label-expanded' : ''}`}
      aria-label="Projets"
      onMouseEnter={() => setIsLabelExpanded(true)}
      onMouseLeave={() => setIsLabelExpanded(false)}
      onFocusCapture={() => setIsLabelExpanded(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setIsLabelExpanded(false)
        }
      }}
    >
      <div className="rail-projects">
        {projects.map((project) => {
          const active = selectedProject?.id === project.id && workspaceView === 'conversations'
          const current = selectedProject?.id === project.id
          const unread = unreadByProject[project.id] ?? 0
          return (
            <div className="rail-project" key={project.id}>
              <span
                className={`rail-project-bar ${active ? 'is-active' : ''} ${!active && unread > 0 ? 'is-unread' : ''}`}
                aria-hidden="true"
              />
              <button
                type="button"
                className={`rail-avatar ${current ? 'is-current' : ''} ${project.id !== selectedProject?.id && activeProjectIds.includes(project.id) ? 'is-live' : ''}`}
                onClick={() => onProjectSelect(project)}
                title={unread > 0 ? `${project.name} · ${unread} à lire` : project.name}
                aria-current={current ? 'true' : undefined}
                aria-label={unread > 0 ? `${project.name}, ${unread} conversation${unread > 1 ? 's' : ''} à lire` : project.name}
              >
                <span className="rail-project-initials">{projectInitials(project.name)}</span>
                <span className="rail-project-label">{project.name}</span>
              </button>
              {unread > 0 ? (
                <span className="rail-project-count" aria-hidden="true">{unread > 9 ? '9+' : unread}</span>
              ) : null}
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
            <span className="rail-add-label">Créer</span>
            <span aria-hidden="true">+</span>
          </button>
        ) : null}
      </div>
    </nav>
  )
})
