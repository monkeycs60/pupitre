import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import {
  createConversation,
  createProject,
  listProjectConversations,
  listProjects,
  setConversationPinned,
  setProjectPinned,
} from './api'
import type { Conversation, Project } from './types'

interface SidebarProps {
  selectedProject: Project | null
  selectedConversation: Conversation | null
  onProjectSelect: (project: Project) => void
  onConversationSelect: (conversation: Conversation) => void
}

function pinnedFirst<T extends { pinned: boolean }>(items: T[]): T[] {
  return [...items].sort((left, right) => Number(right.pinned) - Number(left.pinned))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Une erreur est survenue.'
}

export function Sidebar({
  selectedProject,
  selectedConversation,
  onProjectSelect,
  onConversationSelect,
}: SidebarProps) {
  const [projects, setProjects] = useState<Project[]>([])
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [showProjectForm, setShowProjectForm] = useState(false)
  const [projectName, setProjectName] = useState('')
  const [projectPath, setProjectPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

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
  }, [])

  useEffect(() => {
    let ignore = false
    setConversations([])

    if (selectedProject === null) return

    void listProjectConversations(selectedProject.id)
      .then((items) => {
        if (!ignore) setConversations(pinnedFirst(items))
      })
      .catch((loadError: unknown) => {
        if (!ignore) setError(errorMessage(loadError))
      })

    return () => {
      ignore = true
    }
  }, [selectedProject])

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

  async function handleCreateConversation() {
    if (selectedProject === null) return

    const initialPrompt = window.prompt('Prompt initial de la conversation')?.trim()
    if (!initialPrompt) return

    setIsSubmitting(true)
    setError(null)
    try {
      const conversation = await createConversation({
        projectId: selectedProject.id,
        provider: 'claude',
        model: 'haiku',
        message: initialPrompt,
      })
      setConversations((current) => pinnedFirst([conversation, ...current]))
      onConversationSelect(conversation)
    } catch (createError: unknown) {
      setError(errorMessage(createError))
    } finally {
      setIsSubmitting(false)
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

  return (
    <aside className="sidebar">
      <div className="app-name">Pupitre</div>

      <section className="sidebar-section" aria-labelledby="projects-title">
        <div className="section-heading">
          <h2 id="projects-title">Projets</h2>
          <button
            type="button"
            className="text-button"
            onClick={() => setShowProjectForm((visible) => !visible)}
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
              <div
                className={`navigation-row ${selectedProject?.id === project.id ? 'is-selected' : ''}`}
                key={project.id}
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
                  📌
                </button>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="sidebar-section conversations" aria-labelledby="conversations-title">
        <div className="section-heading">
          <h2 id="conversations-title">Conversations</h2>
          <button
            type="button"
            className="text-button"
            onClick={() => void handleCreateConversation()}
            disabled={selectedProject === null || isSubmitting}
          >
            + Conversation
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
                className={`navigation-row ${selectedConversation?.id === conversation.id ? 'is-selected' : ''}`}
                key={conversation.id}
              >
                <button
                  type="button"
                  className="navigation-main"
                  onClick={() => onConversationSelect(conversation)}
                >
                  <span>{conversation.title}</span>
                  <span className="navigation-detail">
                    {conversation.provider} · {conversation.model}
                  </span>
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
                  📌
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
    </aside>
  )
}
