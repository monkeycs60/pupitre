import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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
  const [previewOrder, setPreviewOrder] = useState<string[] | null>(null)
  const [removalCandidate, setRemovalCandidate] = useState<Project | null>(null)
  const [error, setError] = useState<string | null>(null)
  const rowRefs = useRef(new Map<string, HTMLDivElement>())
  const rowTops = useRef(new Map<string, number>())
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
        setProjects(items)
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

  const byId = new Map(projects.map((project) => [project.id, project]))
  const displayed = previewOrder
    ? previewOrder.flatMap((id) => byId.get(id) ?? [])
    : projects
  const displayedKey = displayed.map((project) => project.id).join(',')

  useLayoutEffect(() => {
    const previous = rowTops.current
    const next = new Map<string, number>()
    for (const [id, element] of rowRefs.current) {
      const top = element.getBoundingClientRect().top
      next.set(id, top)
      const before = previous.get(id)
      if (before === undefined || before === top) continue
      element.style.transition = 'none'
      element.style.transform = `translateY(${before - top}px)`
      void element.offsetHeight
      element.style.transition = ''
      element.style.transform = ''
    }
    rowTops.current = next
  }, [displayedKey])

  function previewMove(targetId: string) {
    if (!draggedId || draggedId === targetId) return
    const order = displayed.map((project) => project.id)
    const targetIndex = order.indexOf(targetId)
    const next = order.filter((id) => id !== draggedId)
    next.splice(targetIndex, 0, draggedId)
    if (next.join(',') !== order.join(',')) setPreviewOrder(next)
  }

  function endDrag() {
    setDraggedId(null)
    setPreviewOrder(null)
  }

  async function commitDrag() {
    const order = previewOrder
    const previous = projects
    endDrag()
    if (!order || order.join(',') === previous.map((project) => project.id).join(',')) return
    setProjects(order.flatMap((id) => byId.get(id) ?? []))
    setSaving(true)
    setError(null)
    try { setProjects(await reorderProjects(order)) }
    catch (reason) {
      setProjects(previous)
      setError(reason instanceof Error ? reason.message : 'Impossible de déplacer le projet.')
    }
    finally { setSaving(false) }
  }

  async function handleRemove(project: Project) {
    setSaving(true)
    setError(null)
    try {
      await removeProject(project.id)
      const remaining = projects.filter((item) => item.id !== project.id)
      setProjects(remaining)
      setRemovalCandidate(null)
      onProjectRemoved?.(project, remaining)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Impossible de retirer le projet.') }
    finally { setSaving(false) }
  }

  return (
    <nav
      className={`rail${isLabelExpanded || isRailPinned ? ' is-label-expanded' : ''}${draggedId ? ' is-reordering' : ''}`}
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
      <div
        className="rail-projects"
        onDragEnter={(event) => { if (draggedId) event.preventDefault() }}
        onDragOver={(event) => { if (draggedId) { event.preventDefault(); event.dataTransfer.dropEffect = 'move' } }}
        onDrop={(event) => { event.preventDefault(); void commitDrag() }}
      >
        {displayed.map((project) => {
          const active = selectedProject?.id === project.id && workspaceView === 'conversations'
          const current = selectedProject?.id === project.id
          const unread = unreadByProject[project.id] ?? 0
          return (
            <div
              className={`rail-project${draggedId === project.id ? ' is-dragging' : ''}`}
              key={project.id}
              ref={(element) => {
                if (element) rowRefs.current.set(project.id, element)
                else rowRefs.current.delete(project.id)
              }}
              draggable={!saving}
              onDragStart={(event) => {
                event.dataTransfer.setData('text/plain', project.id)
                event.dataTransfer.effectAllowed = 'move'
                const id = project.id
                window.setTimeout(() => setDraggedId(id), 0)
              }}
              onDragEnter={() => previewMove(project.id)}
              onDragEnd={endDrag}
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
              <button
                type="button"
                className="rail-project-remove"
                disabled={saving || activeProjectIds.includes(project.id)}
                title={activeProjectIds.includes(project.id) ? 'Un run est en cours dans ce projet' : 'Retirer le projet'}
                aria-label={`Retirer le projet ${project.name}`}
                onClick={() => setRemovalCandidate(project)}
              >
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M6.8 7v4M9.2 7v4" />
                </svg>
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
        {error ? <p role="alert" className="rail-error">{error}</p> : null}
      </div>
      {removalCandidate ? (
        <ProjectRemoveModal
          project={removalCandidate}
          saving={saving}
          onCancel={() => setRemovalCandidate(null)}
          onConfirm={() => void handleRemove(removalCandidate)}
        />
      ) : null}
    </nav>
  )
})

interface ProjectRemoveModalProps {
  project: Project
  saving: boolean
  onCancel: () => void
  onConfirm: () => void
}

function ProjectRemoveModal({ project, saving, onCancel, onConfirm }: ProjectRemoveModalProps) {
  return createPortal(
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={onCancel}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel()
      }}
    >
      <section
        className="switch-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="project-remove-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <h2 id="project-remove-title">Retirer « {project.name} » ?</h2>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="Fermer">×</button>
        </header>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            onConfirm()
          }}
        >
          <p className="project-remove-note">
            Le projet disparaît du rail. Le dossier <code>{project.path}</code> et ses conversations sont
            conservés : ajouter à nouveau ce dossier restaure son historique.
          </p>
          <footer>
            <button type="button" className="secondary-button" onClick={onCancel} autoFocus>
              Annuler
            </button>
            <button type="submit" className="danger-button" disabled={saving}>
              Retirer le projet
            </button>
          </footer>
        </form>
      </section>
    </div>,
    document.body,
  )
}
