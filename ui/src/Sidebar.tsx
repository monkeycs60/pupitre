import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import {
  createProject,
  listProjectConversations,
  listProjectReviews,
  listProjectWorkflows,
  listNotifications,
  listProjects,
  renameConversation,
  setConversationArchived,
  setConversationDeleted,
  runWorkflow,
  setConversationPinned,
  setConversationPermissionMode,
  setProjectPinned,
} from './api'
import { QuotaBar, QuotaStatus } from './QuotaBar'
import type { AppNotification, Conversation, GamificationSnapshot, Project, Review, Workflow, WorkspaceView } from './types'
import type { Quotas } from './useQuotas'
import type { GamificationPulse } from './useGamification'
import { WorkflowDialog } from './WorkflowDialog'
import { ProjectSettingsDialog } from './ProjectSettingsDialog'
import { modelLabel } from './modelOptions'

declare global {
  interface Window {
    __TAURI__?: Record<string, unknown>
  }
}

interface SidebarProps {
  selectedProject: Project | null
  selectedConversation: Conversation | null
  onProjectSelect: (project: Project) => void
  onConversationSelect: (conversation: Conversation) => void
  onConversationCreate: () => void
  onConversationClosed?: () => void
  conversationListVersion: number
  projectListVersion: number
  quotas: Quotas
  /** Sous-tâches en cours dans la conversation ouverte (cf. App). */
  runningSubtasks: number
  workspaceView: WorkspaceView
  onGuardianSelect: () => void
  onGitSelect: () => void
  onCostsSelect: () => void
  onLibrarySelect: () => void
  onRoutinesSelect: () => void
  onFleetSelect: () => void
  onPaletteSelect: () => void
  onMemorySelect: () => void
  onHelpSelect: () => void
  onProgressSelect: () => void
  onSettingsSelect: () => void
  gamification: GamificationSnapshot | null
  xpPulse: GamificationPulse | null
  reviewListVersion: number
}

function pinnedFirst<T extends { pinned: boolean }>(items: T[]): T[] {
  return [...items].sort((left, right) => Number(right.pinned) - Number(left.pinned))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Une erreur est survenue.'
}

function pathBasename(path: string): string {
  const trimmedPath = path.replace(/[\\/]+$/, '')
  return trimmedPath.split(/[\\/]/).pop() || path
}

function conversationRelation(
  conversation: Conversation,
  conversations: Conversation[],
): string | null {
  if (conversation.continued_from) {
    const source = conversations.find((item) => item.id === conversation.continued_from)
    return `↳ suite de ${source?.title ?? 'la conversation précédente'}`
  }
  const continuation = conversations.find(
    (item) => item.continued_from === conversation.id,
  )
  return continuation ? `→ passation vers ${continuation.title}` : null
}

type ConversationScope = 'active' | 'archived' | 'trash'

function relativeConversationTime(value: string): string {
  const elapsed = Math.max(0, Date.now() - Date.parse(value))
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return 'à l’instant'
  if (minutes < 60) return `il y a ${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `il y a ${hours} h`
  const days = Math.floor(hours / 24)
  return days < 7 ? `il y a ${days} j` : new Date(value).toLocaleDateString('fr-FR')
}

type UtilityIconName =
  | 'search'
  | 'guardian'
  | 'git'
  | 'costs'
  | 'fleet'
  | 'memory'
  | 'routines'
  | 'library'
  | 'help'
  | 'progress'
  | 'settings'
  | 'tools'

function UtilityIcon({ name }: { name: UtilityIconName }) {
  const paths: Record<UtilityIconName, React.ReactNode> = {
    search: <><circle cx="7" cy="7" r="4" /><path d="m10 10 3 3" /></>,
    guardian: <path d="M8 2 13 4v4c0 3-2 5-5 6-3-1-5-3-5-6V4l5-2Z" />,
    git: <><circle cx="5" cy="4" r="1.5" /><circle cx="11" cy="12" r="1.5" /><circle cx="5" cy="12" r="1.5" /><path d="M5 5.5v5M6.5 4H8a3 3 0 0 1 3 3v3.5" /></>,
    costs: <><path d="M3 13V8M8 13V3M13 13V6" /><path d="M2 13.5h12" /></>,
    fleet: <><path d="M2 8h3l1.5-4L9 12l1.5-4H14" /><path d="M3 3.5A6 6 0 1 1 2.5 11" /></>,
    memory: <><path d="M4 2.5h6l2 2V14H4Z" /><path d="M10 2.5V5h2M6 8h4M6 10.5h4" /></>,
    routines: <><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3l2 1.5" /></>,
    library: <><path d="M3 3v10M6 3v10M10 3.5l2 9.5M2 13h12" /></>,
    help: <><circle cx="8" cy="8" r="5.5" /><path d="M6.5 6.2A1.7 1.7 0 0 1 8.2 5c1 0 1.8.6 1.8 1.5 0 1.7-2 1.5-2 3M8 11.8v.2" /></>,
    progress: <><path d="M3 13V8M8 13V5M13 13V2" /><path d="M2 13.5h12" /></>,
    settings: <><path d="M6.5 2h3l.5 2a4.5 4.5 0 0 1 1.3.8l1.9-.7 1.5 2.6-1.5 1.3a5 5 0 0 1 0 1.6l1.5 1.3-1.5 2.6-1.9-.7a4.5 4.5 0 0 1-1.3.8l-.5 2h-3l-.5-2a4.5 4.5 0 0 1-1.3-.8l-1.9.7-1.5-2.6 1.5-1.3a5 5 0 0 1 0-1.6L1.3 6.7l1.5-2.6 1.9.7A4.5 4.5 0 0 1 6 4l.5-2Z" /><circle cx="8" cy="8" r="2" /></>,
    tools: <><path d="M3 3h4v4H3zM9 3h4v4H9zM3 9h4v4H3zM9 9h4v4H9z" /></>,
  }

  return (
    <svg className="utility-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.25">
        {paths[name]}
      </g>
    </svg>
  )
}

export function Sidebar({
  selectedProject,
  selectedConversation,
  onProjectSelect,
  onConversationSelect,
  onConversationCreate,
  onConversationClosed,
  conversationListVersion,
  projectListVersion,
  quotas,
  runningSubtasks,
  workspaceView,
  onGuardianSelect,
  onGitSelect,
  onCostsSelect,
  onLibrarySelect,
  onRoutinesSelect,
  onFleetSelect,
  onPaletteSelect,
  onMemorySelect,
  onHelpSelect,
  onProgressSelect,
  onSettingsSelect,
  gamification,
  xpPulse,
  reviewListVersion,
}: SidebarProps) {
  const [projects, setProjects] = useState<Project[]>([])
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [reviews, setReviews] = useState<Review[]>([])
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [showProjectForm, setShowProjectForm] = useState(false)
  const [projectName, setProjectName] = useState('')
  const [projectPath, setProjectPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [showWorkflowDialog, setShowWorkflowDialog] = useState(false)
  const [runningWorkflowId, setRunningWorkflowId] = useState<string | null>(null)
  const [conversationScope, setConversationScope] = useState<ConversationScope>('active')
  const [openConversationMenu, setOpenConversationMenu] = useState<string | null>(null)
  const [renameConversationId, setRenameConversationId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [notifications, setNotifications] = useState<AppNotification[]>([])
  const [utilitiesOpen, setUtilitiesOpen] = useState(false)
  const [projectSettingsProject, setProjectSettingsProject] = useState<Project | null>(null)
  const utilitiesRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!utilitiesOpen) return

    function handlePointerDown(event: PointerEvent) {
      if (!utilitiesRef.current?.contains(event.target as Node)) {
        setUtilitiesOpen(false)
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setUtilitiesOpen(false)
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [utilitiesOpen])

  useEffect(() => {
    let ignore = false

    void listProjects()
      .then((items) => {
        if (!ignore) setProjects(pinnedFirst(items))
      })
      .catch((loadError: unknown) => {
        if (!ignore) setError(errorMessage(loadError))
      })

    return () => {
      ignore = true
    }
  }, [projectListVersion])

  useEffect(() => {
    let ignore = false
    setConversations([])
    setReviews([])
    setWorkflows([])

    if (selectedProject === null) return

    void Promise.all([
      listProjectConversations(selectedProject.id, conversationScope),
      listProjectReviews(selectedProject.id),
      listProjectWorkflows(selectedProject.id),
    ])
      .then(([items, loadedReviews, loadedWorkflows]) => {
        if (!ignore) {
          setConversations(pinnedFirst(items))
          setReviews(loadedReviews)
          setWorkflows(loadedWorkflows)
        }
      })
      .catch((loadError: unknown) => {
        if (!ignore) setError(errorMessage(loadError))
      })

    return () => {
      ignore = true
    }
  }, [selectedProject, conversationListVersion, reviewListVersion, conversationScope])

  useEffect(() => {
    if (!utilitiesOpen) return
    let disposed = false
    void listNotifications(0)
      .then((items) => {
        if (!disposed) setNotifications(items.slice(-8).reverse())
      })
      .catch(() => {
        if (!disposed) setNotifications([])
      })
    return () => {
      disposed = true
    }
  }, [utilitiesOpen])

  const pendingReviews = reviews.filter((review) =>
    review.status === 'running' || review.flags.some(
      (flag) => flag.status === 'open' || flag.status === 'countered',
    ),
  ).length

  async function handleProjectButtonClick() {
    if (window.__TAURI__) {
      setError(null)

      try {
        const selectedPath = await open({ directory: true })
        if (typeof selectedPath !== 'string') return

        setProjectName(pathBasename(selectedPath))
        setProjectPath(selectedPath)
        setShowProjectForm(true)
      } catch (dialogError: unknown) {
        setError(errorMessage(dialogError))
      }

      return
    }

    setShowProjectForm((visible) => !visible)
  }

  async function handleCreateProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = projectName.trim()
    const path = projectPath.trim()
    if (!name || !path) return

    setIsSubmitting(true)
    setError(null)
    try {
      const project = await createProject({ name, path })
      setProjects((current) => pinnedFirst([project, ...current]))
      setProjectName('')
      setProjectPath('')
      setShowProjectForm(false)
      onProjectSelect(project)
    } catch (createError: unknown) {
      setError(errorMessage(createError))
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handleProjectPin(project: Project) {
    setError(null)
    try {
      await setProjectPinned(project.id, !project.pinned)
      const updated = { ...project, pinned: !project.pinned }
      setProjects((current) =>
        pinnedFirst(current.map((item) => (item.id === project.id ? updated : item))),
      )
      if (selectedProject?.id === project.id) onProjectSelect(updated)
    } catch (pinError: unknown) {
      setError(errorMessage(pinError))
    }
  }

  function handleProjectSettings(project: Project) {
    setProjectSettingsProject(project)
  }

  function handleProjectSettingsUpdated(updated: Project) {
    setProjects((current) => current.map((item) => item.id === updated.id ? updated : item))
    if (selectedProject?.id === updated.id) onProjectSelect(updated)
  }

  async function handleConversationPin(conversation: Conversation) {
    setError(null)
    try {
      await setConversationPinned(conversation.id, !conversation.pinned)
      const updated = { ...conversation, pinned: !conversation.pinned }
      setConversations((current) =>
        pinnedFirst(
          current.map((item) => (item.id === conversation.id ? updated : item)),
        ),
      )
      if (selectedConversation?.id === conversation.id) {
        onConversationSelect(updated)
      }
    } catch (pinError: unknown) {
      setError(errorMessage(pinError))
    }
  }

  async function handleConversationYolo(conversation: Conversation) {
    const enabling = conversation.permission_mode !== 'bypassPermissions'
    if (enabling && !window.confirm(
      `Activer YOLO pour « ${conversation.title} » ?\n\nClaude ignorera les demandes de permission pour les tours suivants.`,
    )) return
    setError(null)
    try {
      const updated = await setConversationPermissionMode(
        conversation.id,
        enabling ? 'bypassPermissions' : null,
      )
      setConversations((current) => current.map((item) => item.id === updated.id ? updated : item))
      if (selectedConversation?.id === updated.id) onConversationSelect(updated)
    } catch (permissionError: unknown) {
      setError(errorMessage(permissionError))
    }
  }

  function closeConversationMenu() {
    setOpenConversationMenu(null)
    setRenameConversationId(null)
    setRenameDraft('')
  }

  function startRename(conversation: Conversation) {
    setOpenConversationMenu(null)
    setRenameConversationId(conversation.id)
    setRenameDraft(conversation.title)
  }

  async function handleRenameSubmit(conversation: Conversation) {
    const title = renameDraft.trim()
    if (!title) return
    setError(null)
    try {
      const updated = await renameConversation(conversation.id, title)
      setConversations((current) => current.map((item) => item.id === updated.id ? updated : item))
      if (selectedConversation?.id === updated.id) onConversationSelect(updated)
      closeConversationMenu()
    } catch (renameError: unknown) {
      setError(errorMessage(renameError))
    }
  }

  async function handleArchiveToggle(conversation: Conversation) {
    setError(null)
    try {
      const updated = await setConversationArchived(conversation.id, !conversation.archived)
      setConversations((current) => conversationScope === 'active' && updated.archived
        ? current.filter((item) => item.id !== updated.id)
        : conversationScope === 'archived' && !updated.archived
          ? current.filter((item) => item.id !== updated.id)
          : current.map((item) => item.id === updated.id ? updated : item))
      if (updated.archived && selectedConversation?.id === updated.id) onConversationClosed?.()
      closeConversationMenu()
    } catch (archiveError: unknown) {
      setError(errorMessage(archiveError))
    }
  }

  async function handleTrashToggle(conversation: Conversation) {
    setError(null)
    try {
      const updated = await setConversationDeleted(conversation.id, conversationScope !== 'trash')
      if (conversationScope === 'trash' || updated.deleted_at !== null) {
        setConversations((current) => current.filter((item) => item.id !== updated.id))
      } else {
        setConversations((current) => current.map((item) => item.id === updated.id ? updated : item))
      }
      if (updated.deleted_at !== null && selectedConversation?.id === updated.id) onConversationClosed?.()
      closeConversationMenu()
    } catch (trashError: unknown) {
      setError(errorMessage(trashError))
    }
  }

  async function handleWorkflowRun(workflow: Workflow) {
    if (runningWorkflowId) return
    setRunningWorkflowId(workflow.id)
    setError(null)
    try {
      const conversation = await runWorkflow(workflow.id)
      setConversations((current) => pinnedFirst([conversation, ...current]))
      onConversationSelect(conversation)
    } catch (runError: unknown) {
      setError(errorMessage(runError))
    } finally {
      setRunningWorkflowId(null)
    }
  }

  function selectUtility(action: () => void) {
    setUtilitiesOpen(false)
    action()
  }

  const activeUtilityLabel: Partial<Record<WorkspaceView, string>> = {
    guardian: 'Gardien',
    git: 'Git',
    costs: 'Coûts',
    progress: 'Progression',
    fleet: 'Fleet',
    memory: 'Mémoire',
    routines: 'Routines',
    library: 'Bibliothèque',
    help: 'Aide',
  }

  return (
    <aside className="sidebar">
      <div className="app-name">Pupitre</div>

      <section className="sidebar-section" aria-labelledby="projects-title">
        <div className="section-heading">
          <h2 id="projects-title">Projets</h2>
          <button
            type="button"
            className="text-button"
            onClick={() => void handleProjectButtonClick()}
            aria-expanded={showProjectForm}
          >
            + Projet
          </button>
        </div>

        {showProjectForm && (
          <form className="project-form" onSubmit={handleCreateProject}>
            <label htmlFor="project-name">Nom</label>
            <input
              id="project-name"
              value={projectName}
              onChange={(event) => setProjectName(event.target.value)}
              autoFocus
              required
            />
            <label htmlFor="project-path">Chemin</label>
            <input
              id="project-path"
              value={projectPath}
              onChange={(event) => setProjectPath(event.target.value)}
              placeholder="/chemin/vers/le/projet"
              required
            />
            <div className="form-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => setShowProjectForm(false)}
              >
                Annuler
              </button>
              <button type="submit" className="primary-button" disabled={isSubmitting}>
                Créer
              </button>
            </div>
          </form>
        )}

        <div className="navigation-list">
          {projects.length === 0 ? (
            <p className="list-empty">Aucun projet</p>
          ) : (
            projects.map((project) => (
              <div className="project-navigation-block" key={project.id}>
                <div
                  className={`navigation-row ${selectedProject?.id === project.id ? 'is-selected' : ''}`}
                >
                  <button
                    type="button"
                    className="navigation-main"
                    onClick={() => onProjectSelect(project)}
                    title={project.path}
                  >
                    <span>{project.name}</span>
                    <span className="navigation-detail">{project.path}</span>
                  </button>
                  <button
                    type="button"
                    className={`pin-button ${project.pinned ? 'is-pinned' : ''}`}
                    onClick={() => void handleProjectPin(project)}
                    aria-label={project.pinned ? `Désépingler ${project.name}` : `Épingler ${project.name}`}
                    aria-pressed={project.pinned}
                    title={project.pinned ? 'Désépingler' : 'Épingler'}
                  >
                    <span aria-hidden="true">{project.pinned ? '◆' : '◇'}</span>
                  </button>
                  <button
                    type="button"
                    className="pin-button project-settings-button"
                    onClick={() => handleProjectSettings(project)}
                    aria-label={`Paramètres de ${project.name}`}
                    title="Paramètres du projet"
                  >
                    <span aria-hidden="true">⚙</span>
                  </button>
                </div>
                {selectedProject?.id === project.id && workflows.length > 0 ? (
                  <div className="workflow-shortcuts" aria-label={`Workflows de ${project.name}`}>
                    {workflows.map((workflow) => (
                      <button
                        type="button"
                        key={workflow.id}
                        onClick={() => void handleWorkflowRun(workflow)}
                        disabled={runningWorkflowId !== null}
                        title={`Lancer $${workflow.skill_invocation} dans une nouvelle conversation`}
                      >
                        <span aria-hidden="true">↳</span>
                        <span>{runningWorkflowId === workflow.id ? 'Lancement…' : workflow.name}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ))
          )}
        </div>
      </section>

      <section className="sidebar-section conversations" aria-labelledby="conversations-title">
        <div className="section-heading">
          <h2 id="conversations-title">Conversations</h2>
          <span className="conversation-count">{conversations.length}</span>
        </div>

        {/* Deux libellés entiers ne tiennent pas à côté du titre dans la largeur
            de la sidebar : ils se tronquaient. Ils ont leur propre rangée. */}
        <div className="section-actions">
          <button
            type="button"
            className="section-action"
            onClick={() => setShowWorkflowDialog(true)}
            disabled={selectedProject === null || isSubmitting}
            title="Créer un workflow réutilisable pour ce projet"
          >
            <span aria-hidden="true">+</span>
            <span>Workflow</span>
          </button>
          <button
            type="button"
            className="section-action"
            onClick={onConversationCreate}
            disabled={selectedProject === null || isSubmitting}
            title="Démarrer une nouvelle conversation dans ce projet"
          >
            <span aria-hidden="true">+</span>
            <span>Conversation</span>
          </button>
        </div>

        <div className="conversation-filters" role="tablist" aria-label="Vue des conversations">
          {([['active', 'Actives'], ['archived', 'Archives'], ['trash', 'Corbeille']] as const).map(([scope, label]) => (
            <button
              type="button"
              key={scope}
              role="tab"
              aria-selected={conversationScope === scope}
              className={conversationScope === scope ? 'is-selected' : ''}
              onClick={() => {
                closeConversationMenu()
                setConversationScope(scope)
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="navigation-list">
          {selectedProject === null ? (
            <p className="list-empty">Sélectionnez un projet</p>
          ) : conversations.length === 0 ? (
            <p className="list-empty">Aucune conversation</p>
          ) : (
            conversations.map((conversation) => (
              <div
                className={`navigation-row ${workspaceView === 'conversations' && selectedConversation?.id === conversation.id ? 'is-selected' : ''}`}
                key={conversation.id}
              >
                <button
                  type="button"
                  className="navigation-main"
                  onClick={() => onConversationSelect(conversation)}
                  aria-describedby={`conversation-preview-${conversation.id}`}
                >
                  <span>
                    {conversation.title}
                    {gamification?.conversations[conversation.id] ? (
                      <span
                        className="conversation-complexity"
                        title={`${gamification.conversations[conversation.id].commits} commit(s) · ×${gamification.conversations[conversation.id].multiplier.toLocaleString('fr-FR')}`}
                      >
                        C{gamification.conversations[conversation.id].complexity}
                      </span>
                    ) : null}
                    {selectedConversation?.id === conversation.id &&
                    runningSubtasks > 0 ? (
                      <span
                        className="subtask-dot"
                        title={
                          runningSubtasks === 1
                            ? '1 sous-tâche en cours'
                            : `${runningSubtasks} sous-tâches en cours`
                        }
                        aria-label={
                          runningSubtasks === 1
                            ? '1 sous-tâche en cours'
                            : `${runningSubtasks} sous-tâches en cours`
                        }
                      >
                        ●
                      </span>
                    ) : null}
                  </span>
                  <span className="navigation-detail">
                    {conversation.provider} · {modelLabel(conversation.model)} ·{' '}
                    {conversation.effort ?? 'default'}
                    {conversation.speed === 'fast' ? ' · rapide' : ''}
                  </span>
                  {conversationRelation(conversation, conversations) ? (
                    <span className="conversation-link">
                      {conversationRelation(conversation, conversations)}
                    </span>
                  ) : null}
                </button>
                <div className="conversation-row-actions">
                  <button
                    type="button"
                    className={`pin-button ${conversation.pinned ? 'is-pinned' : ''}`}
                    onClick={() => void handleConversationPin(conversation)}
                    aria-label={conversation.pinned ? `Désépingler ${conversation.title}` : `Épingler ${conversation.title}`}
                    aria-pressed={conversation.pinned}
                    title={conversation.pinned ? 'Désépingler' : 'Épingler'}
                  >
                    <span aria-hidden="true">{conversation.pinned ? '◆' : '◇'}</span>
                  </button>
                  <button
                    type="button"
                    className="conversation-more-button"
                    aria-label={`Actions pour ${conversation.title}`}
                    aria-expanded={openConversationMenu === conversation.id}
                    onClick={() => setOpenConversationMenu((current) => current === conversation.id ? null : conversation.id)}
                  >
                    <span aria-hidden="true">⋯</span>
                  </button>
                  {openConversationMenu === conversation.id ? (
                    <div className="conversation-actions-menu" role="menu">
                      <button type="button" role="menuitem" onClick={() => startRename(conversation)}>Renommer</button>
                      <button type="button" role="menuitem" onClick={() => void handleConversationYolo(conversation)}>
                        {conversation.permission_mode === 'bypassPermissions'
                          ? 'Désactiver YOLO'
                          : 'Activer YOLO'}
                      </button>
                      <button type="button" role="menuitem" onClick={() => void handleArchiveToggle(conversation)}>
                        {conversation.archived ? 'Désarchiver' : 'Archiver'}
                      </button>
                      {conversationScope === 'trash' ? (
                        <button type="button" role="menuitem" onClick={() => void handleTrashToggle(conversation)}>Restaurer</button>
                      ) : (
                        <button type="button" role="menuitem" className="is-danger" onClick={() => void handleTrashToggle(conversation)}>Mettre à la corbeille</button>
                      )}
                    </div>
                  ) : null}
                </div>
                {renameConversationId === conversation.id ? (
                  <form className="conversation-rename-form" onSubmit={(event) => { event.preventDefault(); void handleRenameSubmit(conversation) }}>
                    <input
                      value={renameDraft}
                      onChange={(event) => setRenameDraft(event.target.value)}
                      aria-label={`Nouveau titre pour ${conversation.title}`}
                      autoFocus
                      onKeyDown={(event) => { if (event.key === 'Escape') closeConversationMenu() }}
                    />
                    <button type="submit">OK</button>
                  </form>
                ) : null}
                <div
                  className="conversation-hover-preview"
                  role="tooltip"
                  id={`conversation-preview-${conversation.id}`}
                >
                  <strong>{conversation.title}</strong>
                  <p>{conversation.summary || conversation.title}</p>
                  <span>{conversation.provider} · {modelLabel(conversation.model)} · {relativeConversationTime(conversation.updated_at)}</span>
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      {error && (
        <p className="sidebar-error" role="alert">
          {error}
        </p>
      )}

      {showWorkflowDialog && selectedProject ? (
        <WorkflowDialog
          key={selectedProject.id}
          project={selectedProject}
          workflows={workflows}
          onClose={() => setShowWorkflowDialog(false)}
          onChanged={setWorkflows}
        />
      ) : null}

      {projectSettingsProject ? (
        <ProjectSettingsDialog
          key={projectSettingsProject.id}
          project={projectSettingsProject}
          onClose={() => setProjectSettingsProject(null)}
          onUpdated={handleProjectSettingsUpdated}
        />
      ) : null}

      <div className="utility-dock" ref={utilitiesRef}>
        {gamification ? (
          <button
            type="button"
            className="progress-strip"
            onClick={onProgressSelect}
            title="Voir la progression et le rapport hebdomadaire"
          >
            <span className="progress-strip-heading">
              <strong>Niveau {gamification.level}</strong>
              <span>{gamification.xp.toLocaleString('fr-FR')} XP</span>
            </span>
            <span className="progress-strip-track" aria-hidden="true">
              <span style={{ width: `${gamification.progress * 100}%` }} />
            </span>
            <span className="progress-strip-meta">
              {Math.floor(gamification.activeMsToday / 60_000)} min actives
            </span>
            {xpPulse ? (
              <span className="xp-pulse" key={xpPulse.id} aria-live="polite">+{xpPulse.amount} XP</span>
            ) : null}
          </button>
        ) : null}
        <QuotaStatus snapshot={quotas.snapshot} />

        {/* Le panneau est positionné par rapport au bouton, pas par rapport à
            tout le pied de sidebar : sinon il flottait au-dessus du niveau et
            des quotas, avec un vide inexpliqué sous lui. */}
        <div className="utility-anchor">
        {utilitiesOpen ? (
          <div className="utility-popover" role="dialog" aria-label="Outils et vues secondaires">
            <button
              type="button"
              className="utility-search"
              onClick={() => selectUtility(onPaletteSelect)}
            >
              <UtilityIcon name="search" />
              <span>Rechercher partout</span>
              <kbd>Ctrl K</kbd>
            </button>

            <section className="utility-group" aria-labelledby="project-tools-title">
              <h3 id="project-tools-title">Projet</h3>
              <div className="utility-grid">
                <button
                  type="button"
                  className={workspaceView === 'guardian' ? 'is-selected' : ''}
                  onClick={() => selectUtility(onGuardianSelect)}
                  disabled={selectedProject === null}
                >
                  <UtilityIcon name="guardian" />
                  <span>Gardien</span>
                  {pendingReviews > 0 ? <strong>{pendingReviews}</strong> : null}
                </button>
                <button
                  type="button"
                  className={workspaceView === 'git' ? 'is-selected' : ''}
                  onClick={() => selectUtility(onGitSelect)}
                  disabled={selectedProject === null}
                >
                  <UtilityIcon name="git" />
                  <span>Git</span>
                </button>
                <button
                  type="button"
                  className={workspaceView === 'costs' ? 'is-selected' : ''}
                  onClick={() => selectUtility(onCostsSelect)}
                  disabled={selectedProject === null}
                >
                  <UtilityIcon name="costs" />
                  <span>Coûts</span>
                </button>
              </div>
            </section>

            <section className="utility-group" aria-labelledby="application-tools-title">
              <h3 id="application-tools-title">Application</h3>
              <div className="utility-grid">
                <button
                  type="button"
                  className={workspaceView === 'settings' ? 'is-selected' : ''}
                  onClick={() => selectUtility(onSettingsSelect)}
                >
                  <UtilityIcon name="settings" />
                  <span>Paramètres</span>
                </button>
              </div>
            </section>

            <section className="utility-group" aria-labelledby="workspace-tools-title">
              <h3 id="workspace-tools-title">Espace de travail</h3>
              <div className="utility-grid">
                <button type="button" className={workspaceView === 'progress' ? 'is-selected' : ''} onClick={() => selectUtility(onProgressSelect)}>
                  <UtilityIcon name="progress" /><span>Progression</span>
                </button>
                <button type="button" className={workspaceView === 'fleet' ? 'is-selected' : ''} onClick={() => selectUtility(onFleetSelect)}>
                  <UtilityIcon name="fleet" /><span>Fleet</span>
                </button>
                <button type="button" className={workspaceView === 'memory' ? 'is-selected' : ''} onClick={() => selectUtility(onMemorySelect)}>
                  <UtilityIcon name="memory" /><span>Mémoire</span>
                </button>
                <button type="button" className={workspaceView === 'routines' ? 'is-selected' : ''} onClick={() => selectUtility(onRoutinesSelect)}>
                  <UtilityIcon name="routines" /><span>Routines</span>
                </button>
                <button type="button" className={workspaceView === 'library' ? 'is-selected' : ''} onClick={() => selectUtility(onLibrarySelect)}>
                  <UtilityIcon name="library" /><span>Bibliothèque</span>
                </button>
                <button type="button" className={workspaceView === 'help' ? 'is-selected' : ''} onClick={() => selectUtility(onHelpSelect)}>
                  <UtilityIcon name="help" /><span>Aide</span>
                </button>
              </div>
            </section>

            <details className="utility-quotas">
              <summary>Quotas et limites</summary>
              <QuotaBar snapshot={quotas.snapshot} />
            </details>

            {/* Après les outils : on ouvre ce panneau pour naviguer, pas pour
                lire ses notifications — et la liste est longue. */}
            <details className="utility-quotas utility-notifications-block">
              <summary>
                Notifications
                {notifications.length > 0 ? <span className="utility-badge">{notifications.length}</span> : null}
              </summary>
              <section className="utility-notifications" aria-label="Notifications récentes">
                {notifications.length === 0 ? (
                  <p>Aucune notification récente.</p>
                ) : notifications.map((notification) => {
                  const target = notification.conversation_id
                    ? conversations.find((item) => item.id === notification.conversation_id)
                    : null
                  return (
                    <button
                      type="button"
                      key={notification.id}
                      className="utility-notification"
                      disabled={target === null}
                      onClick={() => target && selectUtility(() => onConversationSelect(target))}
                      title={target ? 'Ouvrir la conversation' : notification.body}
                    >
                      <strong>{notification.title}</strong>
                      <span>{notification.body}</span>
                    </button>
                  )
                })}
              </section>
            </details>
          </div>
        ) : null}

        <button
          type="button"
          className={`utility-trigger ${workspaceView !== 'conversations' ? 'is-active' : ''}`}
          onClick={() => setUtilitiesOpen((open) => !open)}
          aria-expanded={utilitiesOpen}
          aria-haspopup="dialog"
        >
          <UtilityIcon name="tools" />
          <span>Outils</span>
          {activeUtilityLabel[workspaceView] ? (
            <span className="utility-current">{activeUtilityLabel[workspaceView]}</span>
          ) : null}
          <span className="utility-chevron" aria-hidden="true">⌃</span>
        </button>
        </div>
      </div>
    </aside>
  )
}
