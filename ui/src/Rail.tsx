import { Fragment, useEffect, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { createProject, listProjectConversations, listProjects } from './api'
import type { Project, WorkspaceView } from './types'

/** Rail vertical (56 px) : bascule de projet + navigation globale.
 *  Remplace la liste de projets et le tiroir « Outils » de l'ancienne sidebar. */

interface RailProps {
  selectedProject: Project | null
  projectListVersion: number
  conversationListVersion?: number
  onProjectSelect: (project: Project) => void
  onProjectCreated: (project: Project) => void
  workspaceView: WorkspaceView
  onConversationsSelect: () => void
  onGitSelect: () => void
  onDocumentsSelect: () => void
  onDesignSelect: () => void
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
  /** Projets ayant au moins un run actif dans Fleet. */
  activeProjectIds?: string[]
}

type NavName =
  | 'conversations'
  | 'fleet'
  | 'git'
  | 'documents'
  | 'design'
  | 'progress'
  | 'costs'
  | 'library'
  | 'memory'
  | 'routines'
  | 'help'
  | 'settings'

const NAV_PATHS: Record<NavName, React.ReactNode> = {
  conversations: (
    <>
      <path d="M3 3h10v7H7l-3.5 2v-2H3Z" />
      <path d="M5.5 6h5M5.5 8h3" />
    </>
  ),
  fleet: <path d="M2 8h3l1.5-4L9 12l1.5-4H14" />,
  git: (
    <>
      <circle cx="5" cy="4" r="1.5" />
      <circle cx="11" cy="12" r="1.5" />
      <circle cx="5" cy="12" r="1.5" />
      <path d="M5 5.5v5M6.5 4H8a3 3 0 0 1 3 3v3.5" />
    </>
  ),
  documents: (
    <>
      <path d="M3 2.5h6l3 3V14H3Z" />
      <path d="M9 2.5V6h3M5.5 9h4M5.5 11.5h4" />
    </>
  ),
  design: (
    <>
      <path d="M8 2.2 2.6 13.4h10.8Z" />
      <path d="M5.4 9.2h5.2" />
    </>
  ),
  progress: (
    <>
      <path d="M3 12.5 6.2 9l2.1 1.8L13 4.5" />
      <path d="M10.5 4.5H13V7" />
    </>
  ),
  costs: (
    <>
      <circle cx="8" cy="8" r="5" />
      <path d="M9.7 5.8c-.4-.4-1-.6-1.7-.6-1 0-1.7.5-1.7 1.2 0 1.8 3.4.8 3.4 2.4 0 .7-.7 1.2-1.7 1.2-.8 0-1.4-.2-1.8-.7M8 4.5v7" />
    </>
  ),
  library: <path d="m8 2.5 1.3 4.2 4.2 1.3-4.2 1.3L8 13.5l-1.3-4.2L2.5 8l4.2-1.3Z" />,
  memory: (
    <>
      <ellipse cx="8" cy="4" rx="4.5" ry="1.8" />
      <path d="M3.5 4v3.5c0 1.1 2 2 4.5 2s4.5-.9 4.5-2V4M3.5 7.5V11c0 1.1 2 2 4.5 2s4.5-.9 4.5-2V7.5" />
      <path d="M6 4.2h4M6 7.7h4M6 11.2h4" />
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
  conversationListVersion = 0,
  onProjectSelect,
  onProjectCreated,
  workspaceView,
  onConversationsSelect,
  onGitSelect,
  onDocumentsSelect,
  onDesignSelect,
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
    void listProjects()
      .then((items) => {
        if (ignore) return
        const ordered = pinnedFirst(items)
        setProjects(ordered)
        void Promise.all(ordered.map(async (project) => {
          try {
            const conversations = await listProjectConversations(project.id)
            return [project.id, conversations.filter((conversation) => conversation.digest_turn > (conversation.last_read_turn ?? 0)).length] as const
          } catch {
            return [project.id, 0] as const
          }
        })).then((entries) => {
          if (!ignore) setUnreadByProject(Object.fromEntries(entries))
        })
      })
      .catch(() => {})
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

  const nav: Array<{
    name: NavName
    label: string
    view: WorkspaceView
    onClick: () => void
    needsProject?: boolean
    badge?: number
  }> = [
    {
      name: 'conversations',
      label: 'Conversations',
      view: 'conversations',
      onClick: onConversationsSelect,
      badge: selectedProject ? unreadByProject[selectedProject.id] ?? 0 : 0,
    },
    { name: 'fleet', label: 'Fleet', view: 'fleet', onClick: onFleetSelect, badge: fleetActive },
    { name: 'git', label: 'Git', view: 'git', onClick: onGitSelect, needsProject: true, badge: pendingReviews },
    { name: 'documents', label: 'Documents', view: 'documents', onClick: onDocumentsSelect },
    { name: 'design', label: 'Claude Design', view: 'design', onClick: onDesignSelect },
    { name: 'progress', label: 'Progression', view: 'progress', onClick: onProgressSelect },
    { name: 'costs', label: 'Coûts & quotas', view: 'costs', onClick: onCostsSelect, needsProject: true },
    { name: 'library', label: 'Skills', view: 'library', onClick: onLibrarySelect },
    { name: 'memory', label: 'Mémoire', view: 'memory', onClick: onMemorySelect },
    { name: 'routines', label: 'Routines', view: 'routines', onClick: onRoutinesSelect },
    { name: 'help', label: 'Aide', view: 'help', onClick: onHelpSelect },
    { name: 'settings', label: 'Réglages', view: 'settings', onClick: onSettingsSelect },
  ]

  return (
    <nav
      className={`rail${isLabelExpanded || isRailPinned ? ' is-label-expanded' : ''}`}
      aria-label="Projets et navigation"
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
          return (
            <div className="rail-project" key={project.id}>
              <span className={`rail-project-bar ${active ? 'is-active' : ''}`} aria-hidden="true" />
              <button
                type="button"
                className={`rail-avatar ${current ? 'is-current' : ''} ${project.id !== selectedProject?.id && activeProjectIds.includes(project.id) ? 'is-live' : ''}`}
                onClick={() => onProjectSelect(project)}
                title={project.name}
                aria-current={current ? 'true' : undefined}
              >
                <span className="rail-project-initials">{projectInitials(project.name)}</span>
                <span className="rail-project-label">{project.name}</span>
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
            <span className="rail-add-label">Créer</span>
            <span aria-hidden="true">+</span>
          </button>
        ) : null}
      </div>

      <div className="rail-spacer" />
      <div className="rail-divider" aria-hidden="true" />

      <div className="rail-nav">
        {nav.map((item) => (
          <Fragment key={item.name}>
            {item.name === 'progress' ? <div className="rail-nav-divider" aria-hidden="true" /> : null}
            <button
              type="button"
              className={`rail-nav-button ${workspaceView === item.view ? 'is-active' : ''}`}
              onClick={item.onClick}
              disabled={item.needsProject && selectedProject === null}
              title={item.label}
              aria-label={`${item.label}${item.name === 'conversations' && item.badge ? `, ${item.badge} à lire` : ''}`}
              aria-current={workspaceView === item.view ? 'true' : undefined}
            >
              <RailIcon name={item.name} />
              <span className="rail-nav-label">{item.label}</span>
              {item.badge && item.badge > 0 ? (
                <span
                  className={`rail-badge ${item.name === 'fleet' ? 'is-live' : ''} ${item.name === 'conversations' ? 'is-unread' : ''}`}
                  aria-hidden="true"
                >{item.name === 'conversations' ? item.badge : null}</span>
              ) : null}
            </button>
          </Fragment>
        ))}
      </div>
    </nav>
  )
}
