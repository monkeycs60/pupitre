import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import {
  createProject,
  listProjectConversations,
  listProjectReviews,
  listProjectWorkflows,
  listProjects,
  runWorkflow,
  setConversationPinned,
  setProjectPinned,
} from './api'
import { QuotaBar, QuotaStatus } from './QuotaBar'
import type { Conversation, Project, Review, Workflow, WorkspaceView } from './types'
import type { Quotas } from './useQuotas'
import { WorkflowDialog } from './WorkflowDialog'

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
  const [utilitiesOpen, setUtilitiesOpen] = useState(false)
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
      listProjectConversations(selectedProject.id),
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
  }, [selectedProject?.id, conversationListVersion, reviewListVersion])

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
                >
                  <span>
                    {conversation.title}
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
                    {conversation.provider} · {conversation.model} ·{' '}
                    {conversation.effort ?? 'default'}
                    {conversation.speed === 'fast' ? ' · rapide' : ''}
                  </span>
                  {conversationRelation(conversation, conversations) ? (
                    <span className="conversation-link">
                      {conversationRelation(conversation, conversations)}
                    </span>
                  ) : null}
                </button>
                <button
                  type="button"
                  className={`pin-button ${conversation.pinned ? 'is-pinned' : ''}`}
                  onClick={() => void handleConversationPin(conversation)}
                  aria-label={
                    conversation.pinned
                      ? `Désépingler ${conversation.title}`
                      : `Épingler ${conversation.title}`
                  }
                  aria-pressed={conversation.pinned}
                  title={conversation.pinned ? 'Désépingler' : 'Épingler'}
                >
                  <span aria-hidden="true">{conversation.pinned ? '◆' : '◇'}</span>
                </button>
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

      <div className="utility-dock" ref={utilitiesRef}>
        <QuotaStatus snapshot={quotas.snapshot} />

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

            <section className="utility-group" aria-labelledby="workspace-tools-title">
              <h3 id="workspace-tools-title">Espace de travail</h3>
              <div className="utility-grid">
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
    </aside>
  )
}
