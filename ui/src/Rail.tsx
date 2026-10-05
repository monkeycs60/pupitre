import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { open } from '@tauri-apps/plugin-dialog'
import { createProject, getUnreadConversationCounts, listProjects, reorderProjects, removeProject, updateProject, type ProjectAppearancePatch } from './api'
import type { Project, WorkspaceView } from './types'
import { retryUntilAvailable } from './startupRetry'
import { ProjectAvatar } from './ProjectAvatar'
import { ProjectAppearancePanel, ProjectMenu } from './ProjectActions'

/** Rail vertical (56 px) : bascule de projet. Les destinations globales
 *  vivent dans la barre de titre. */

interface RailProps {
  selectedProject: Project | null
  projectListVersion: number
  conversationListVersion?: number
  onProjectSelect: (project: Project) => void
  onProjectCreated: (project: Project) => void
  onProjectRemoved?: (project: Project, remaining: Project[]) => void
  onProjectUpdated?: (project: Project) => void
  workspaceView: WorkspaceView
  /** Projets ayant au moins un run actif dans Fleet. */
  activeProjectIds?: string[]
}

function pathBasename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  return trimmed.split(/[\\/]/).pop() || path
}

interface DragGeometry {
  top: number
  slot: number
  scrollTop: number
}

type Popup = { kind: 'menu' | 'appearance'; projectId: string; anchor: DOMRect }

const ARCHIVE_OPEN_KEY = 'pupitre.rail.archiveOpen'

function readArchiveOpen(): boolean {
  try { return localStorage.getItem(ARCHIVE_OPEN_KEY) === '1' } catch { return false }
}

export const Rail = memo(function Rail({
  selectedProject,
  projectListVersion,
  conversationListVersion = 0,
  onProjectSelect,
  onProjectCreated,
  onProjectRemoved,
  onProjectUpdated,
  workspaceView,
  activeProjectIds = [],
}: RailProps) {
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [previewOrder, setPreviewOrder] = useState<string[] | null>(null)
  const [removalCandidate, setRemovalCandidate] = useState<Project | null>(null)
  const [popup, setPopup] = useState<Popup | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [archiveOpen, setArchiveOpen] = useState(readArchiveOpen)
  const [error, setError] = useState<string | null>(null)
  const navRef = useRef<HTMLElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const rowRefs = useRef(new Map<string, HTMLDivElement>())
  const rowTops = useRef(new Map<string, number>())
  const dragGeometry = useRef<DragGeometry | null>(null)
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
  const isExpanded = isLabelExpanded || isRailPinned || popup !== null || renamingId !== null

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
      setProjects((current) => [project, ...current.filter((item) => item.id !== project.id)])
      onProjectCreated(project)
    } catch {
      // Dialog annulée ou création refusée : rien à afficher dans le rail.
    }
  }

  const byId = new Map(projects.map((project) => [project.id, project]))
  const activeProjects = projects.filter((project) => !project.archived_at)
  const archivedProjects = projects.filter((project) => project.archived_at)
  const displayed = previewOrder
    ? previewOrder.flatMap((id) => byId.get(id) ?? [])
    : activeProjects
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

  function startDrag(projectId: string) {
    const first = activeProjects[0] && rowRefs.current.get(activeProjects[0].id)
    const second = activeProjects[1] && rowRefs.current.get(activeProjects[1].id)
    if (!first) return
    const firstRect = first.getBoundingClientRect()
    dragGeometry.current = {
      top: firstRect.top,
      slot: second ? second.getBoundingClientRect().top - firstRect.top : firstRect.height,
      scrollTop: listRef.current?.scrollTop ?? 0,
    }
    window.setTimeout(() => setDraggedId(projectId), 0)
  }

  /** L'emplacement visé ne dépend que de la hauteur du pointeur, mesurée sur la
   *  grille relevée au début du glisser : les lignes qui s'animent sous le
   *  curseur ne peuvent pas relancer un déplacement. */
  function previewAt(clientY: number) {
    const geometry = dragGeometry.current
    if (!draggedId || !geometry || geometry.slot <= 0) return
    const scrolled = (listRef.current?.scrollTop ?? 0) - geometry.scrollTop
    const others = activeProjects.map((project) => project.id).filter((id) => id !== draggedId)
    const index = Math.max(0, Math.min(others.length, Math.floor((clientY + scrolled - geometry.top) / geometry.slot)))
    const next = [...others]
    next.splice(index, 0, draggedId)
    const current = displayed.map((project) => project.id)
    if (next.join(',') !== current.join(',')) setPreviewOrder(next)
  }

  function endDrag() {
    dragGeometry.current = null
    setDraggedId(null)
    setPreviewOrder(null)
  }

  async function commitDrag() {
    const order = previewOrder
    const previous = projects
    endDrag()
    if (!order || order.join(',') === activeProjects.map((project) => project.id).join(',')) return
    const fullOrder = [...order, ...archivedProjects.map((project) => project.id)]
    setProjects(fullOrder.flatMap((id) => byId.get(id) ?? []))
    setSaving(true)
    setError(null)
    try { setProjects(await reorderProjects(fullOrder)) }
    catch (reason) {
      setProjects(previous)
      setError(reason instanceof Error ? reason.message : 'Impossible de déplacer le projet.')
    }
    finally { setSaving(false) }
  }

  async function patchProject(project: Project, patch: ProjectAppearancePatch) {
    const updated = await updateProject(project.id, patch)
    setProjects((current) => current.map((item) => (item.id === updated.id ? updated : item)))
    onProjectUpdated?.(updated)
  }

  async function runPatch(project: Project, patch: ProjectAppearancePatch) {
    setError(null)
    try { await patchProject(project, patch) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Modification impossible.') }
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

  function closePopup() {
    setPopup(null)
    if (!navRef.current?.matches(':hover')) setIsLabelExpanded(false)
  }

  function toggleArchive() {
    const next = !archiveOpen
    setArchiveOpen(next)
    try { localStorage.setItem(ARCHIVE_OPEN_KEY, next ? '1' : '0') } catch { /* stockage indisponible */ }
  }

  function renderRow(project: Project, archived: boolean) {
    const active = selectedProject?.id === project.id && workspaceView === 'conversations'
    const current = selectedProject?.id === project.id
    const unread = unreadByProject[project.id] ?? 0
    const live = activeProjectIds.includes(project.id)
    const renaming = renamingId === project.id
    const menuOpen = popup?.projectId === project.id
    return (
      <div
        className={`rail-project${draggedId === project.id ? ' is-dragging' : ''}${archived ? ' is-archived' : ''}${menuOpen ? ' is-menu-open' : ''}`}
        key={project.id}
        ref={archived ? undefined : (element) => {
          if (element) rowRefs.current.set(project.id, element)
          else rowRefs.current.delete(project.id)
        }}
        draggable={!archived && !saving && !renaming}
        onDragStart={archived ? undefined : (event) => {
          event.dataTransfer.setData('text/plain', project.id)
          event.dataTransfer.effectAllowed = 'move'
          setPopup(null)
          startDrag(project.id)
        }}
        onDragEnd={archived ? undefined : endDrag}
      >
        <span
          className={`rail-project-bar ${active ? 'is-active' : ''} ${!active && unread > 0 ? 'is-unread' : ''}`}
          aria-hidden="true"
        />
        {renaming ? (
          <form
            className="rail-avatar rail-rename"
            onSubmit={(event) => {
              event.preventDefault()
              const name = new FormData(event.currentTarget).get('name')
              setRenamingId(null)
              if (typeof name === 'string' && name.trim() && name.trim() !== project.name) void runPatch(project, { name })
            }}
          >
            <ProjectAvatar project={project} />
            <input
              name="name"
              aria-label={`Nouveau nom du projet ${project.name}`}
              defaultValue={project.name}
              autoFocus
              onFocus={(event) => event.currentTarget.select()}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return
                event.currentTarget.value = project.name
                setRenamingId(null)
              }}
              onBlur={(event) => event.currentTarget.form?.requestSubmit()}
            />
          </form>
        ) : (
          <button
            type="button"
            className={`rail-avatar ${current ? 'is-current' : ''} ${project.id !== selectedProject?.id && live ? 'is-live' : ''}`}
            onClick={() => onProjectSelect(project)}
            onDoubleClick={() => setRenamingId(project.id)}
            title={unread > 0 ? `${project.name} · ${unread} à lire` : project.name}
            aria-current={current ? 'true' : undefined}
            aria-label={unread > 0 ? `${project.name}, ${unread} conversation${unread > 1 ? 's' : ''} à lire` : project.name}
          >
            <ProjectAvatar project={project} />
            <span className="rail-project-label">{project.name}</span>
          </button>
        )}
        {renaming ? null : (
          <button
            type="button"
            className="rail-project-more"
            aria-label={`Actions pour le projet ${project.name}`}
            aria-haspopup="menu"
            aria-expanded={popup?.kind === 'menu' && menuOpen}
            onClick={(event) => {
              const row = event.currentTarget.getBoundingClientRect()
              const railRight = navRef.current?.getBoundingClientRect().right ?? row.right
              const anchor = new DOMRect(railRight, row.top - 6, 0, row.height)
              setPopup(popup?.kind === 'menu' && menuOpen ? null : { kind: 'menu', projectId: project.id, anchor })
            }}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
              <circle cx="3.5" cy="8" r="1.3" /><circle cx="8" cy="8" r="1.3" /><circle cx="12.5" cy="8" r="1.3" />
            </svg>
          </button>
        )}
        {unread > 0 && !renaming ? (
          <span className="rail-project-count" aria-hidden="true">{unread > 9 ? '9+' : unread}</span>
        ) : null}
      </div>
    )
  }

  const popupProject = popup ? byId.get(popup.projectId) ?? null : null

  return (
    <nav
      ref={navRef}
      className={`rail${isExpanded ? ' is-label-expanded' : ''}${draggedId ? ' is-reordering' : ''}`}
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
        ref={listRef}
        className="rail-projects"
        onDragEnter={(event) => { if (draggedId) event.preventDefault() }}
        onDragOver={(event) => {
          if (!draggedId) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
          previewAt(event.clientY)
        }}
        onDrop={(event) => { event.preventDefault(); void commitDrag() }}
      >
        {displayed.map((project) => renderRow(project, false))}
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
        {archivedProjects.length > 0 ? (
          <div className={`rail-archive${archiveOpen ? ' is-open' : ''}`}>
            <button
              type="button"
              className="rail-archive-toggle"
              aria-expanded={archiveOpen}
              title={`${archivedProjects.length} projet${archivedProjects.length > 1 ? 's' : ''} archivé${archivedProjects.length > 1 ? 's' : ''}`}
              onClick={toggleArchive}
            >
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M2.5 3.5h11v2.5h-11zM3.5 6v6.5h9V6M6.5 8.5h3" />
              </svg>
              <span className="rail-archive-label">Archives</span>
              <span className="rail-archive-count">{archivedProjects.length}</span>
            </button>
            {archiveOpen ? archivedProjects.map((project) => renderRow(project, true)) : null}
          </div>
        ) : null}
        {error ? <p role="alert" className="rail-error">{error}</p> : null}
      </div>
      {popup?.kind === 'menu' && popupProject ? (
        <ProjectMenu
          project={popupProject}
          anchor={popup.anchor}
          live={activeProjectIds.includes(popupProject.id)}
          onClose={closePopup}
          onRename={() => setRenamingId(popupProject.id)}
          onAppearance={() => setPopup({ kind: 'appearance', projectId: popupProject.id, anchor: popup.anchor })}
          onToggleArchive={() => void runPatch(popupProject, { archived: !popupProject.archived_at })}
          onRemove={() => setRemovalCandidate(popupProject)}
        />
      ) : null}
      {popup?.kind === 'appearance' && popupProject ? (
        <ProjectAppearancePanel
          project={popupProject}
          anchor={popup.anchor}
          onClose={closePopup}
          onChange={(patch) => patchProject(popupProject, patch)}
        />
      ) : null}
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
