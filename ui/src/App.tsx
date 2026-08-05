import { useState } from 'react'
import './App.css'
import { Chat } from './Chat'
import { Sidebar } from './Sidebar'
import { SwitchModelModal } from './SwitchModelModal'
import { GuardianView } from './GuardianView'
import { ReviewDialog } from './ReviewDialog'
import type { Conversation, Project, Review } from './types'
import { useConversationEvents } from './useConversationEvents'
import { useQuotas } from './useQuotas'
import { ContextGauge } from './ContextGauge'
import { GitView } from './GitView'
import { listProjectConversations } from './api'

function App() {
  const [selectedProject, setSelectedProject] = useState<Project | null>(null)
  const [selectedConversation, setSelectedConversation] =
    useState<Conversation | null>(null)
  const [isCreatingConversation, setIsCreatingConversation] = useState(false)
  const [conversationListVersion, setConversationListVersion] = useState(0)
  const [projectListVersion, setProjectListVersion] = useState(0)
  const [showSwitchModel, setShowSwitchModel] = useState(false)
  const [showReviewDialog, setShowReviewDialog] = useState(false)
  const [workspaceView, setWorkspaceView] = useState<'conversations' | 'git' | 'guardian'>(
    'conversations',
  )
  const [focusedReviewId, setFocusedReviewId] = useState<string | null>(null)
  const [reviewListVersion, setReviewListVersion] = useState(0)
  // Décision D1 : l'info « sous-tâches en vol » vit dans le fil de la
  // conversation ouverte — la sidebar n'en affiche l'indicateur que pour elle.
  const [runningSubtasks, setRunningSubtasks] = useState(0)
  const { events, connection, retryAt } = useConversationEvents(
    workspaceView === 'conversations' ? selectedConversation?.id ?? null : null,
  )
  const quotas = useQuotas()

  function handleProjectSelect(project: Project) {
    if (project.id !== selectedProject?.id) {
      setSelectedConversation(null)
      setIsCreatingConversation(false)
      setShowSwitchModel(false)
      setShowReviewDialog(false)
      setWorkspaceView('conversations')
      setFocusedReviewId(null)
    }
    setSelectedProject(project)
  }

  function handleConversationSelect(conversation: Conversation) {
    setSelectedConversation(conversation)
    setIsCreatingConversation(false)
    setShowSwitchModel(false)
    setShowReviewDialog(false)
    setWorkspaceView('conversations')
  }

  function handleConversationCreate() {
    if (selectedProject === null) return
    setSelectedConversation(null)
    setIsCreatingConversation(true)
    setShowSwitchModel(false)
    setShowReviewDialog(false)
    setWorkspaceView('conversations')
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

  function handleGuardianSelect() {
    if (selectedProject === null) return
    setWorkspaceView('guardian')
    setShowSwitchModel(false)
    setShowReviewDialog(false)
  }

  function handleGitSelect() {
    if (selectedProject === null) return
    setWorkspaceView('git')
    setShowSwitchModel(false)
    setShowReviewDialog(false)
  }

  async function handleGitConversationSelect(conversationId: string) {
    if (selectedProject === null) return
    const conversations = await listProjectConversations(selectedProject.id)
    const conversation = conversations.find((item) => item.id === conversationId)
    if (conversation) handleConversationSelect(conversation)
  }

  function handleGitGuardianSelect(reviewId: string) {
    setFocusedReviewId(reviewId)
    setWorkspaceView('guardian')
  }

  function handleReviewStarted(review: Review) {
    setShowReviewDialog(false)
    setFocusedReviewId(review.id)
    setWorkspaceView('guardian')
    setReviewListVersion((current) => current + 1)
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
        workspaceView={workspaceView}
        onGuardianSelect={handleGuardianSelect}
        onGitSelect={handleGitSelect}
        reviewListVersion={reviewListVersion}
      />

      <section className="workspace" aria-label={workspaceView === 'guardian' ? 'Gardien' : workspaceView === 'git' ? 'Git' : 'Conversation'}>
        {selectedProject === null ? (
          <div className="empty-state">
            <p>Sélectionnez un projet pour commencer.</p>
          </div>
        ) : workspaceView === 'guardian' ? (
          <GuardianView
            key={`${selectedProject.id}-${focusedReviewId ?? 'latest'}`}
            project={selectedProject}
            initialReviewId={focusedReviewId}
            refreshToken={reviewListVersion}
            onProjectUpdated={handleProjectUpdated}
            onReviewsChanged={() => setReviewListVersion((current) => current + 1)}
          />
        ) : workspaceView === 'git' ? (
          <GitView
            project={selectedProject}
            onConversationSelect={(conversationId) => void handleGitConversationSelect(conversationId)}
            onGuardianSelect={handleGitGuardianSelect}
          />
        ) : selectedConversation === null && !isCreatingConversation ? (
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
                {selectedConversation !== null ? (
                  <ContextGauge
                    conversation={selectedConversation}
                    events={events}
                    onHandoffSuggested={() => setShowSwitchModel(true)}
                  />
                ) : null}
              </div>
              {selectedConversation !== null ? (
                <div className="header-actions">
                  <button
                    type="button"
                    className="header-action"
                    onClick={() => setShowReviewDialog(true)}
                    title="Analyser le dernier diff Git avec un modèle fort"
                  >
                    Review Gardien
                  </button>
                  <button
                    type="button"
                    className="header-action"
                    onClick={() => setShowSwitchModel(true)}
                  >
                    Changer de modèle
                  </button>
                </div>
              ) : null}
            </header>
            <Chat
              key={selectedConversation?.id ?? `new-${selectedProject.id}`}
              events={selectedConversation === null ? [] : events}
              connection={connection}
              retryAt={retryAt}
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
            {showReviewDialog && selectedConversation !== null ? (
              <ReviewDialog
                key={selectedConversation.id}
                conversation={selectedConversation}
                project={selectedProject}
                onClose={() => setShowReviewDialog(false)}
                onStarted={handleReviewStarted}
              />
            ) : null}
          </>
        )}
      </section>
    </main>
  )
}

export default App
