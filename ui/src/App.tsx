import { useState } from 'react'
import './App.css'
import { Chat } from './Chat'
import { Sidebar } from './Sidebar'
import type { Conversation, Project } from './types'
import { useConversationEvents } from './useConversationEvents'

function App() {
  const [selectedProject, setSelectedProject] = useState<Project | null>(null)
  const [selectedConversation, setSelectedConversation] =
    useState<Conversation | null>(null)
  const [isCreatingConversation, setIsCreatingConversation] = useState(false)
  const [conversationListVersion, setConversationListVersion] = useState(0)
  const events = useConversationEvents(selectedConversation?.id ?? null)

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
                    {selectedConversation.provider} · {selectedConversation.model}
                  </p>
                ) : null}
              </div>
            </header>
            <Chat
              key={selectedConversation?.id ?? `new-${selectedProject.id}`}
              events={selectedConversation === null ? [] : events}
              conversation={selectedConversation}
              projectId={selectedProject.id}
              onConversationCreated={handleConversationCreated}
            />
          </>
        )}
      </section>
    </main>
  )
}

export default App
