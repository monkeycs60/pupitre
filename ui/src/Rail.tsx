import { memo, type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { open } from '@tauri-apps/plugin-dialog'
import { createProject, createProjectGroup, deleteProjectGroup, getUnreadConversationCounts, listProjectGroups, listProjects, reorderProjects, removeProject, updateProject, updateProjectGroup, type ProjectAppearancePatch } from './api'
import type { Project, ProjectGroup, WorkspaceView } from './types'
import { retryUntilAvailable } from './startupRetry'
import { ProjectAvatar } from './ProjectAvatar'
import { ProjectAppearancePanel, ProjectGroupMenu, ProjectMenu } from './ProjectActions'

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
  /** Nombre de conversations en cours par projet, d'après Fleet. */
  liveConversationsByProject?: Record<string, number>
}

function pathBasename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  return trimmed.split(/[\\/]/).pop() || path
}

interface DragGeometry {
  /** Milieu de chaque ligne visible au début du glisser, projet glissé exclu. */
  slots: Array<{ id: string; mid: number }>
  /** Ordre complet sans le projet glissé, membres des groupes repliés compris. */
  order: string[]
  scrollTop: number
}

type Popup = { kind: 'menu' | 'appearance'; projectId: string; anchor: DOMRect }

export type RailItem = { kind: 'project'; project: Project } | { kind: 'group'; group: ProjectGroup; members: Project[] }

/** Un groupe prend la place de son premier projet et rassemble les autres derrière lui. */
export function railItems(projects: Project[], groups: ProjectGroup[]): RailItem[] {
  const known = new Map(groups.map((group) => [group.id, group]))
  const members = new Map<string, Project[]>()
  for (const project of projects) {
    if (project.group_id && known.has(project.group_id)) members.set(project.group_id, [...(members.get(project.group_id) ?? []), project])
  }
  const items: RailItem[] = []
  for (const project of projects) {
    const group = project.group_id ? known.get(project.group_id) : undefined
    if (!group) items.push({ kind: 'project', project })
    else if (members.get(group.id)![0] === project) items.push({ kind: 'group', group, members: members.get(group.id)! })
  }
  return items
}

const flatten = (items: RailItem[]) => items.flatMap((item) => item.kind === 'group' ? item.members : [item.project])

/** Groupe d'un projet déposé en `index` : celui de ses deux voisins s'ils le partagent, le sien s'il reste collé à son groupe, aucun sinon. */
export function dropGroup(order: string[], index: number, own: string | null, groupOf: (id: string) => string | null): string | null {
  const before = index > 0 ? groupOf(order[index - 1]!) : null
  const after = index < order.length - 1 ? groupOf(order[index + 1]!) : null
  if (before && before === after) return before
  if (own && (before === own || after === own)) return own
  return null
}

const FOLDED_GROUPS_KEY = 'pupitre.rail.foldedGroups'

function readFoldedGroups(): Set<string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(FOLDED_GROUPS_KEY) ?? '[]')
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [])
  } catch { return new Set() }
}

const isGroup = (value: unknown): value is ProjectGroup => typeof value === 'object' && value !== null
  && typeof (value as ProjectGroup).id === 'string' && typeof (value as ProjectGroup).name === 'string' && typeof (value as ProjectGroup).color === 'string'

const LIVE_RING_MAX = 6

/** Une comète par conversation en cours, réparties à égale distance sur
 *  l'anneau : le nombre se lit d'un coup d'œil, au-delà de six on ne compte plus. */
function LiveRing({ count }: { count: number }) {
  const shown = Math.min(count, LIVE_RING_MAX)
  const period = 360 / shown
  const style = { '--live-period': `${period}deg`, '--live-arc': `${Math.min(120, period * 0.55)}deg` } as CSSProperties
  return <span className="rail-live-ring" data-count={shown} style={style} aria-hidden="true" />
}

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
  liveConversationsByProject = {},
}: RailProps) {
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ order: string[]; group: string | null } | null>(null)
  const [groups, setGroups] = useState<ProjectGroup[]>([])
  const [foldedGroups, setFoldedGroups] = useState(readFoldedGroups)
  const [groupPopup, setGroupPopup] = useState<{ groupId: string; anchor: DOMRect } | null>(null)
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null)
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
  const isExpanded = isLabelExpanded || isRailPinned || popup !== null || renamingId !== null || groupPopup !== null || renamingGroupId !== null

  useEffect(() => {
    let ignore = false
    void retryUntilAvailable(
      () => listProjects(),
      { cancelled: () => ignore },
    )
      .then((items) => {
        if (ignore || items === null) return
        setProjects(items)
        void listProjectGroups().then((next) => {
          if (!ignore && Array.isArray(next)) setGroups(next.filter(isGroup))
        }).catch(() => {})
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
  const displayed = preview
    ? preview.order.flatMap((id) => {
      const project = byId.get(id)
      if (!project) return []
      return id === draggedId ? [{ ...project, group_id: preview.group }] : [project]
    })
    : activeProjects
  const items = railItems(displayed, groups)
  const displayedKey = flatten(items).map((project) => project.id).join(',')

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
    const order = flatten(railItems(activeProjects, groups)).map((project) => project.id).filter((id) => id !== projectId)
    const slots = order.flatMap((id) => {
      const rect = rowRefs.current.get(id)?.getBoundingClientRect()
      return rect ? [{ id, mid: rect.top + rect.height / 2 }] : []
    })
    dragGeometry.current = { slots, order, scrollTop: listRef.current?.scrollTop ?? 0 }
    window.setTimeout(() => setDraggedId(projectId), 0)
  }

  /** L'emplacement visé ne dépend que de la hauteur du pointeur, mesurée sur les
   *  lignes relevées au début du glisser : les lignes qui s'animent sous le
   *  curseur ne peuvent pas relancer un déplacement. */
  function previewAt(clientY: number) {
    const geometry = dragGeometry.current
    if (!draggedId || !geometry) return
    const y = clientY + (listRef.current?.scrollTop ?? 0) - geometry.scrollTop
    const nextVisible = geometry.slots.find((slot) => slot.mid > y)
    const index = nextVisible ? geometry.order.indexOf(nextVisible.id) : geometry.order.length
    const order = [...geometry.order]
    order.splice(index, 0, draggedId)
    const group = dropGroup(order, index, byId.get(draggedId)?.group_id ?? null, (id) => byId.get(id)?.group_id ?? null)
    if (order.join(',') !== preview?.order.join(',') || group !== preview?.group) setPreview({ order, group })
  }

  function endDrag() {
    dragGeometry.current = null
    setDraggedId(null)
    setPreview(null)
  }

  async function reloadProjects() {
    const [nextProjects, nextGroups] = await Promise.all([listProjects(), listProjectGroups()])
    setProjects(nextProjects)
    setGroups(nextGroups.filter(isGroup))
  }

  async function commitDrag() {
    const dragged = draggedId ? byId.get(draggedId) : undefined
    const target = preview
    const previous = projects
    const order = flatten(items).map((project) => project.id)
    endDrag()
    if (!dragged || !target) return
    const groupChanged = (dragged.group_id ?? null) !== target.group
    if (!groupChanged && order.join(',') === flatten(railItems(activeProjects, groups)).map((project) => project.id).join(',')) return
    const fullOrder = [...order, ...archivedProjects.map((project) => project.id)]
    setProjects(fullOrder.flatMap((id) => {
      const project = byId.get(id)
      if (!project) return []
      return id === dragged.id ? [{ ...project, group_id: target.group }] : [project]
    }))
    setSaving(true)
    setError(null)
    try {
      if (groupChanged) await updateProject(dragged.id, { groupId: target.group })
      setProjects(await reorderProjects(fullOrder))
      if (groupChanged) await reloadProjects()
    }
    catch (reason) {
      setProjects(previous)
      setError(reason instanceof Error ? reason.message : 'Impossible de déplacer le projet.')
    }
    finally { setSaving(false) }
  }

  async function runGroupAction(action: () => Promise<unknown>) {
    setError(null)
    try { await action(); await reloadProjects() }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Modification du groupe impossible.') }
  }

  function setFolded(groupId: string, folded: boolean) {
    const next = new Set(foldedGroups)
    if (folded) next.add(groupId)
    else next.delete(groupId)
    setFoldedGroups(next)
    try { localStorage.setItem(FOLDED_GROUPS_KEY, JSON.stringify([...next])) } catch { /* stockage indisponible */ }
  }

  async function handleNewGroup(project: Project) {
    await runGroupAction(async () => {
      const group = await createProjectGroup('Nouveau groupe', [project.id])
      setFolded(group.id, false)
      setRenamingGroupId(group.id)
    })
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
    const liveCount = liveConversationsByProject[project.id] ?? 0
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
            className={`rail-avatar ${current ? 'is-current' : ''}`}
            onClick={() => onProjectSelect(project)}
            onDoubleClick={() => setRenamingId(project.id)}
            title={[project.name, liveCount > 0 ? `${liveCount} en cours` : '', unread > 0 ? `${unread} à lire` : ''].filter(Boolean).join(' · ')}
            aria-current={current ? 'true' : undefined}
            aria-label={[project.name, liveCount > 0 ? `${liveCount} conversation${liveCount > 1 ? 's' : ''} en cours` : '', unread > 0 ? `${unread} conversation${unread > 1 ? 's' : ''} à lire` : ''].filter(Boolean).join(', ')}
          >
            <span className="rail-avatar-slot">
              <ProjectAvatar project={project} />
              {liveCount > 0 ? <LiveRing count={liveCount} /> : null}
              {unread > 0 ? (
                <span className="rail-project-count" aria-hidden="true">{unread > 9 ? '9+' : unread}</span>
              ) : null}
            </span>
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
      </div>
    )
  }

  function renderGroup(group: ProjectGroup, members: Project[]) {
    const folded = foldedGroups.has(group.id) && renamingGroupId !== group.id
    const unread = members.reduce((sum, project) => sum + (unreadByProject[project.id] ?? 0), 0)
    const live = members.reduce((sum, project) => sum + (liveConversationsByProject[project.id] ?? 0), 0)
    const holdsCurrent = members.some((project) => project.id === selectedProject?.id)
    const count = `${members.length} projet${members.length > 1 ? 's' : ''}`
    return (
      <div
        key={`group-${group.id}`}
        className={`rail-group${folded ? ' is-folded' : ''}${groupPopup?.groupId === group.id ? ' is-menu-open' : ''}`}
        data-group-id={group.id}
        style={{ '--group-color': group.color } as CSSProperties}
      >
        <div className="rail-group-head">
          {renamingGroupId === group.id ? (
            <form
              className="rail-group-rename"
              onSubmit={(event) => {
                event.preventDefault()
                const name = new FormData(event.currentTarget).get('name')
                setRenamingGroupId(null)
                if (typeof name === 'string' && name.trim() && name.trim() !== group.name) void runGroupAction(() => updateProjectGroup(group.id, { name }))
              }}
            >
              <input
                name="name"
                aria-label={`Nouveau nom du groupe ${group.name}`}
                defaultValue={group.name}
                autoFocus
                onFocus={(event) => event.currentTarget.select()}
                onKeyDown={(event) => {
                  if (event.key !== 'Escape') return
                  event.currentTarget.value = group.name
                  setRenamingGroupId(null)
                }}
                onBlur={(event) => event.currentTarget.form?.requestSubmit()}
              />
            </form>
          ) : (
            <button
              type="button"
              className={`rail-group-toggle${folded && holdsCurrent ? ' is-current' : ''}`}
              aria-expanded={!folded}
              aria-label={`Groupe ${group.name}, ${count}${unread > 0 ? `, ${unread} à lire` : ''}`}
              title={[group.name, count, live > 0 ? `${live} en cours` : '', unread > 0 ? `${unread} à lire` : ''].filter(Boolean).join(' · ')}
              onClick={() => setFolded(group.id, !folded)}
              onDoubleClick={() => setRenamingGroupId(group.id)}
            >
              <span className="rail-group-chevron" aria-hidden="true">▾</span>
              <span className="rail-group-name">{group.name}</span>
              {folded ? (
                <span className="rail-group-dots" aria-hidden="true">
                  {members.slice(0, 4).map((project) => <i key={project.id} style={{ background: project.color }} />)}
                </span>
              ) : null}
              <span className="rail-group-count" aria-hidden="true">{members.length}</span>
              {folded && unread > 0 ? <span className="rail-project-count" aria-hidden="true">{unread > 9 ? '9+' : unread}</span> : null}
            </button>
          )}
          {renamingGroupId === group.id ? null : (
            <button
              type="button"
              className="rail-project-more rail-group-more"
              aria-label={`Actions pour le groupe ${group.name}`}
              aria-haspopup="menu"
              aria-expanded={groupPopup?.groupId === group.id}
              onClick={(event) => {
                const row = event.currentTarget.getBoundingClientRect()
                const railRight = navRef.current?.getBoundingClientRect().right ?? row.right
                setPopup(null)
                setGroupPopup(groupPopup?.groupId === group.id ? null : { groupId: group.id, anchor: new DOMRect(railRight, row.top - 6, 0, row.height) })
              }}
            >
              <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
                <circle cx="3.5" cy="8" r="1.3" /><circle cx="8" cy="8" r="1.3" /><circle cx="12.5" cy="8" r="1.3" />
              </svg>
            </button>
          )}
        </div>
        {folded ? null : members.map((project) => renderRow(project, false))}
      </div>
    )
  }

  const popupProject = popup ? byId.get(popup.projectId) ?? null : null
  const popupGroup = groupPopup ? groups.find((group) => group.id === groupPopup.groupId) ?? null : null

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
        {items.map((item) => item.kind === 'group' ? renderGroup(item.group, item.members) : renderRow(item.project, false))}
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
          live={(liveConversationsByProject[popupProject.id] ?? 0) > 0}
          onClose={closePopup}
          onRename={() => setRenamingId(popupProject.id)}
          onAppearance={() => setPopup({ kind: 'appearance', projectId: popupProject.id, anchor: popup.anchor })}
          onToggleArchive={() => void runPatch(popupProject, { archived: !popupProject.archived_at })}
          onRemove={() => setRemovalCandidate(popupProject)}
          groups={groups}
          onGroup={(groupId) => void runGroupAction(() => updateProject(popupProject.id, { groupId }))}
          onNewGroup={() => void handleNewGroup(popupProject)}
        />
      ) : null}
      {groupPopup && popupGroup ? (
        <ProjectGroupMenu
          group={popupGroup}
          anchor={groupPopup.anchor}
          onClose={() => {
            setGroupPopup(null)
            if (!navRef.current?.matches(':hover')) setIsLabelExpanded(false)
          }}
          onRename={() => { setFolded(popupGroup.id, false); setRenamingGroupId(popupGroup.id) }}
          onColor={(color) => void runGroupAction(() => updateProjectGroup(popupGroup.id, { color }))}
          onDissolve={() => void runGroupAction(() => deleteProjectGroup(popupGroup.id))}
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
