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
  const events = useConversationEvents(selectedConversation?.id ?? null)

  function handleProjectSelect(project: Project) {
    if (project.id !== selectedProject?.id) setSelectedConversation(null)
    setSelectedProject(project)
  }

  return (
    <main className="app-shell">
      <Sidebar
        selectedProject={selectedProject}
        selectedConversation={selectedConversation}
        onProjectSelect={handleProjectSelect}
        onConversationSelect={setSelectedConversation}
      />

      <section className="workspace" aria-label="Conversation">
        {selectedConversation === null ? (
          <div className="empty-state">
            <p>Sélectionnez une conversation pour afficher ses événements.</p>
          </div>
        ) : (
          <>
            <header className="conversation-header">
              <div>
                <h1>{selectedConversation.title}</h1>
                <p>
                  {selectedConversation.provider} · {selectedConversation.model}
                </p>
              </div>
            </header>
            <Chat key={selectedConversation.id} events={events} />
          </>
        )}
      </section>
    </main>
  )
}

export default App
