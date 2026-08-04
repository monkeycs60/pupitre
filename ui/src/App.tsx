import { useState } from 'react'
import './App.css'
import { Chat } from './Chat'
import { Sidebar } from './Sidebar'
import type { Conversation, Project } from './types'
import { useConversationEvents } from './useConversationEvents'
import { useQuotas } from './useQuotas'

function App() {
  const [selectedProject, setSelectedProject] = useState<Project | null>(null)
  const [selectedConversation, setSelectedConversation] =
    useState<Conversation | null>(null)
  const [isCreatingConversation, setIsCreatingConversation] = useState(false)
  const [conversationListVersion, setConversationListVersion] = useState(0)
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
    }
    setSelectedProject(project)
  }

  function handleConversationSelect(conversation: Conversation) {
    setSelectedConversation(conversation)
    setIsCreatingConversation(false)
  }

  function handleConversationCreate() {
    if (selectedProject === null) return
    setSelectedConversation(null)
    setIsCreatingConversation(true)
  }

  function handleConversationCreated(conversation: Conversation) {
    setSelectedConversation(conversation)
    setIsCreatingConversation(false)
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
            </header>
            <Chat
              key={selectedConversation?.id ?? `new-${selectedProject.id}`}
              events={selectedConversation === null ? [] : events}
              connection={connection}
              conversation={selectedConversation}
              projectId={selectedProject.id}
              quotas={quotas.snapshot}
              onConversationCreated={handleConversationCreated}
              onRunningSubtasksChange={setRunningSubtasks}
            />
          </>
        )}
      </section>
    </main>
  )
}

export default App
