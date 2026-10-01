import { memo, useEffect, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { createProject, getUnreadConversationCounts, listProjects, reorderProjects, removeProject } from './api'
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
  onProjectRemoved?: (project: Project, remaining: Project[]) => void
  workspaceView: WorkspaceView
  /** Projets ayant au moins un run actif dans Fleet. */
  activeProjectIds?: string[]
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
  onProjectRemoved,
  workspaceView,
  activeProjectIds = [],
}: RailProps) {
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [menuTop, setMenuTop] = useState(8)
  const [menuId, setMenuId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
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
        const ordered = items
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
      setProjects((current) => [project, ...current])
      onProjectCreated(project)
    } catch {
      // Dialog annulée ou création refusée : rien à afficher dans le rail.
    }
  }

  function openProjectMenu(project: Project, element: HTMLElement) {
    setMenuTop(Math.max(8, Math.min(element.getBoundingClientRect().top, window.innerHeight - 152)))
    setMenuId(menuId === project.id ? null : project.id)
  }

  async function moveProject(sourceId: string, targetId: string, after: boolean) {
    setDraggedId(null)
    if (sourceId === targetId || saving) return
    const next = projects.filter((project) => project.id !== sourceId)
    const source = projects.find((project) => project.id === sourceId)
    if (!source) return
    next.splice(next.findIndex((project) => project.id === targetId) + Number(after), 0, source)
    setSaving(true)
    setError(null)
    try { setProjects(await reorderProjects(next.map((project) => project.id))) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Impossible de déplacer le projet.') }
    finally { setSaving(false) }
  }

  async function handleRemove(project: Project) {
    if (!window.confirm(`Retirer « ${project.name} » de Pupitre ? Les fichiers et les conversations sont conservés. Ajouter à nouveau ce dossier restaure son historique.`)) return
    setSaving(true)
    setError(null)
    try {
      await removeProject(project.id)
      const remaining = projects.filter((item) => item.id !== project.id)
      setProjects(remaining)
      setMenuId(null)
      onProjectRemoved?.(project, remaining)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Impossible de retirer le projet.') }
    finally { setSaving(false) }
  }

  return (
    <nav
      className={`rail${isLabelExpanded || isRailPinned || menuId !== null ? ' is-label-expanded' : ''}`}
      aria-label="Projets"
      onMouseEnter={() => setIsLabelExpanded(true)}
      onMouseLeave={() => setIsLabelExpanded(false)}
      onFocusCapture={() => setIsLabelExpanded(true)}
      onKeyDown={(event) => { if (event.key === 'Escape') setMenuId(null) }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setIsLabelExpanded(false)
          setMenuId(null)
        }
      }}
    >
      <div className="rail-projects">
        {projects.map((project) => {
          const active = selectedProject?.id === project.id && workspaceView === 'conversations'
          const current = selectedProject?.id === project.id
          const unread = unreadByProject[project.id] ?? 0
          return (
            <div className={`rail-project${draggedId === project.id ? ' is-dragging' : ''}`} key={project.id}
              data-project-id={project.id}
              draggable={!saving}
              onDragStart={(event) => { setDraggedId(project.id); event.dataTransfer.setData('text/plain', project.id); event.dataTransfer.effectAllowed = 'move' }}
              onDragEnd={() => setDraggedId(null)}
              onDragOver={(event) => { if (draggedId && !saving) { event.preventDefault(); event.dataTransfer.dropEffect = 'move' } }}
              onDrop={(event) => {
                event.preventDefault()
                if (!draggedId) return
                const rect = event.currentTarget.getBoundingClientRect()
                void moveProject(draggedId, project.id, event.clientY > rect.top + rect.height / 2)
              }}
              onContextMenu={(event) => { event.preventDefault(); openProjectMenu(project, event.currentTarget) }}
            >
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
              <button type="button" className="rail-project-more" aria-label={`Actions pour le projet ${project.name}`} aria-expanded={menuId === project.id} onClick={(event) => openProjectMenu(project, event.currentTarget)}>⋯</button>
              {menuId === project.id ? <div className="rail-project-menu" style={{ top: menuTop }} role="menu" aria-label={`Actions du projet ${project.name}`}>
                <button role="menuitem" disabled={saving || projects.indexOf(project) === 0} onClick={() => void moveProject(project.id, projects[projects.indexOf(project) - 1]!.id, false)}>Monter</button>
                <button role="menuitem" disabled={saving || projects.indexOf(project) === projects.length - 1} onClick={() => void moveProject(project.id, projects[projects.indexOf(project) + 1]!.id, true)}>Descendre</button>
                <button role="menuitem" disabled={saving || activeProjectIds.includes(project.id)} onClick={() => void handleRemove(project)}>Retirer de Pupitre</button>
                <button role="menuitem" onClick={() => setMenuId(null)}>Fermer</button>
              </div> : null}
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
        {error ? <p role="alert" className="rail-error">{error}</p> : null}
      </div>
    </nav>
  )
})
