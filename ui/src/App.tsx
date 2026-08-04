import { useState } from 'react'
import './App.css'
import { Chat } from './Chat'
import { Sidebar } from './Sidebar'
import { SwitchModelModal } from './SwitchModelModal'
import type { Conversation, Project } from './types'
import { useConversationEvents } from './useConversationEvents'
import { useQuotas } from './useQuotas'

function App() {
  const [selectedProject, setSelectedProject] = useState<Project | null>(null)
  const [selectedConversation, setSelectedConversation] =
    useState<Conversation | null>(null)
  const [isCreatingConversation, setIsCreatingConversation] = useState(false)
  const [conversationListVersion, setConversationListVersion] = useState(0)
  const [projectListVersion, setProjectListVersion] = useState(0)
  const [showSwitchModel, setShowSwitchModel] = useState(false)
  // Décision D1 : l'info « sous-tâches en vol » vit dans le fil de la
  // conversation ouverte — la sidebar n'en affiche l'indicateur que pour elle.
  const [runningSubtasks, setRunningSubtasks] = useState(0)
  const { events, connection } = useConversationEvents(
    selectedConversation?.id ?? null,
  )
  const quotas = useQuotas()

  function handleProjectSelect(project: Project) {
    if (project.id !== selectedProject?.id) {
      setSelectedConversation(null)
      setIsCreatingConversation(false)
      setShowSwitchModel(false)
    }
    setSelectedProject(project)
  }

  function handleConversationSelect(conversation: Conversation) {
    setSelectedConversation(conversation)
    setIsCreatingConversation(false)
    setShowSwitchModel(false)
  }

  function handleConversationCreate() {
    if (selectedProject === null) return
    setSelectedConversation(null)
    setIsCreatingConversation(true)
    setShowSwitchModel(false)
  }

  function handleConversationCreated(conversation: Conversation) {
    setSelectedConversation(conversation)
    setIsCreatingConversation(false)
    setConversationListVersion((current) => current + 1)
  }

  function handleProjectUpdated(project: Project) {
    setSelectedProject(project)
    setProjectListVersion((current) => current + 1)
  }

  function handleConversationSwitched(conversation: Conversation) {
    setSelectedConversation(conversation)
    setShowSwitchModel(false)
    setConversationListVersion((current) => current + 1)
  }

  function handleConversationHandoff(conversation: Conversation) {
    setSelectedConversation(conversation)
    setIsCreatingConversation(false)
    setShowSwitchModel(false)
    setConversationListVersion((current) => current + 1)
  }

  return (
    <main className="app-shell">
      <Sidebar
        selectedProject={selectedProject}
        selectedConversation={selectedConversation}
        onProjectSelect={handleProjectSelect}
        onConversationSelect={handleConversationSelect}
        onConversationCreate={handleConversationCreate}
        conversationListVersion={conversationListVersion}
        projectListVersion={projectListVersion}
        quotas={quotas}
        runningSubtasks={runningSubtasks}
      />

      <section className="workspace" aria-label="Conversation">
        {selectedProject === null ||
        (selectedConversation === null && !isCreatingConversation) ? (
          <div className="empty-state">
            <p>Sélectionnez une conversation pour afficher ses événements.</p>
          </div>
        ) : (
          <>
            <header className="conversation-header">
              <div>
                <h1>{selectedConversation?.title ?? 'Nouvelle conversation'}</h1>
                {selectedConversation !== null ? (
                  <p>
                    {selectedConversation.provider} · {selectedConversation.model} ·{' '}
                    {selectedConversation.effort ?? 'default'}
                    {selectedConversation.speed === 'fast' ? ' · rapide' : ''}
                  </p>
                ) : null}
              </div>
              {selectedConversation !== null ? (
                <button
                  type="button"
                  className="header-action"
                  onClick={() => setShowSwitchModel(true)}
                >
                  Changer de modèle
                </button>
              ) : null}
            </header>
            <Chat
              key={selectedConversation?.id ?? `new-${selectedProject.id}`}
              events={selectedConversation === null ? [] : events}
              connection={connection}
              conversation={selectedConversation}
              project={selectedProject}
              quotas={quotas.snapshot}
              onConversationCreated={handleConversationCreated}
              onProjectUpdated={handleProjectUpdated}
              onRunningSubtasksChange={setRunningSubtasks}
            />
            {showSwitchModel && selectedConversation !== null ? (
              <SwitchModelModal
                key={selectedConversation.id}
                conversation={selectedConversation}
                events={events}
                onClose={() => setShowSwitchModel(false)}
                onSwitched={handleConversationSwitched}
                onHandoff={handleConversationHandoff}
              />
            ) : null}
          </>
        )}
      </section>
    </main>
  )
}

export default App
