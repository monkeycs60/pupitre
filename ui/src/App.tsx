import { useCallback, useEffect, useState } from 'react'
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react'
import { Chat } from './Chat'
import { Sidebar } from './Sidebar'
import { Titlebar } from './Titlebar'
import { SwitchModelModal } from './SwitchModelModal'
import { GuardianView } from './GuardianView'
import { ReviewDialog } from './ReviewDialog'
import type { Conversation, Project, Review } from './types'
import { useConversationEvents } from './useConversationEvents'
import { useQuotas } from './useQuotas'
import { ContextGauge } from './ContextGauge'
import { GitView } from './GitView'
import {
  getGardienStatus,
  getProjectContextProfile,
  getSettings,
  listProjectConversations,
  listProjectMcpServers,
  listProjects,
} from './api'
import type { ContextProfile, McpServerRef } from './api'
import { ActionFormatContext, DEFAULT_ACTION_FORMAT } from './actionHeadings'
import { modelLabel } from './modelOptions'
import type { ActionFormat } from './actionHeadings'
import { guardianAckCount } from './groupEvents'
import { SkillsLibrary } from './SkillsLibrary'
import { RoutinesView } from './RoutinesView'
import { useAppNotifications } from './useAppNotifications'
import { FleetView } from './FleetView'
import { CommandPalette } from './CommandPalette'
import { createDebrief, createTestInventory } from './api'
import type { SkillSummary } from './types'
import { CostsView } from './CostsView'
import { MemoryView } from './MemoryView'
import { ResumeCommandButton } from './ResumeCommandButton'
import { HelpView } from './HelpView'
import type { AppEvent, WorkspaceView } from './types'
import { useGamification } from './useGamification'
import { ProgressView } from './ProgressView'
import { AppSettingsView } from './AppSettingsView'
import { ProjectSettingsDialog } from './ProjectSettingsDialog'

const DEFAULT_SIDEBAR_WIDTH = 296
const MIN_SIDEBAR_WIDTH = 240
const MAX_SIDEBAR_WIDTH = 420
const SIDEBAR_WIDTH_STORAGE_KEY = 'pupitre.sidebar-width'

function clampSidebarWidth(width: number): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width))
}

function storedSidebarWidth(): number {
  const stored = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)
  const parsed = stored === null ? Number.NaN : Number.parseInt(stored, 10)
  return Number.isFinite(parsed)
    ? clampSidebarWidth(parsed)
    : DEFAULT_SIDEBAR_WIDTH
}

/** Dernier digest reçu dans le flux, ou null si la conversation n'en a pas encore. */
function lastDigest(events: AppEvent[]): { title: string; summary: string } | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type === 'conversation-digest') {
      return { title: event.title, summary: event.summary }
    }
  }
  return null
}

function App() {
  const [selectedProject, setSelectedProject] = useState<Project | null>(null)
  const [selectedConversation, setSelectedConversation] =
    useState<Conversation | null>(null)
  const [isCreatingConversation, setIsCreatingConversation] = useState(false)
  const [newConversationDraft, setNewConversationDraft] = useState('')
  const [conversationListVersion, setConversationListVersion] = useState(0)
  const [projectListVersion, setProjectListVersion] = useState(0)
  const [showSwitchModel, setShowSwitchModel] = useState(false)
  const [showReviewDialog, setShowReviewDialog] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [helpSlug, setHelpSlug] = useState<string | null>(null)
  const [memoryDirty, setMemoryDirty] = useState(false)
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>('conversations')
  const [focusedReviewId, setFocusedReviewId] = useState<string | null>(null)
  const [reviewListVersion, setReviewListVersion] = useState(0)
  const [gardienPollVersion, setGardienPollVersion] = useState(0)
  const [sidebarWidth, setSidebarWidth] = useState(storedSidebarWidth)
  // Décision D1 : l'info « sous-tâches en vol » vit dans le fil de la
  // conversation ouverte — la sidebar n'en affiche l'indicateur que pour elle.
  const [runningSubtasks, setRunningSubtasks] = useState(0)
  // Intitulés reconnus pour les blocs d'actions : chargés une fois, diffusés à
  // tout le rendu Markdown.
  const [actionFormat, setActionFormat] = useState<ActionFormat>(DEFAULT_ACTION_FORMAT)
  /** Coût mesuré du bridge MCP `conductor`, calculé par le sidecar. */
  const [conductorTokens, setConductorTokens] = useState(0)
  /** Charge fixe mesurée : contexte d'un tour à vide. */
  const [contextBaseline, setContextBaseline] = useState(0)
  /** Poids mesurés des instructions et des serveurs MCP du projet ouvert. */
  const [contextProfile, setContextProfile] = useState<ContextProfile>({
    instructionsTokens: 0,
    mcpTokens: 0,
  })
  /** Serveurs MCP configurés par l'utilisateur pour le projet ouvert. */
  const [mcpServers, setMcpServers] = useState<McpServerRef[]>([])
  /** Dernier poids mesuré par serveur, affiché dans le diagnostic de contexte. */
  const [mcpWeights, setMcpWeights] = useState<Record<string, { tokens: number | null }>>({})
  /** Configuration du projet ouverte depuis le diagnostic de contexte. */
  const [projectSettingsOpen, setProjectSettingsOpen] = useState(false)
  const { events, connection, retryAt } = useConversationEvents(
    workspaceView === 'conversations' ? selectedConversation?.id ?? null : null,
  )
  const quotas = useQuotas()
  const gamification = useGamification()
  useAppNotifications()
  const guardianAckEventCount = guardianAckCount(events)
  // Le digest est régénéré côté sidecar après un tour : on rafraîchit le titre
  // affiché sans recharger la conversation.
  const digest = lastDigest(events)
  const digestTitle = digest?.title
  const digestSummary = digest?.summary
  useEffect(() => {
    if (digestTitle === undefined || digestSummary === undefined) return
    setSelectedConversation((current) =>
      current === null
      || (current.title === digestTitle && current.summary === digestSummary)
        ? current
        : { ...current, title: digestTitle, summary: digestSummary },
    )
    setConversationListVersion((current) => current + 1)
  }, [digestTitle, digestSummary])
  const effectiveReviewListVersion = reviewListVersion
    + guardianAckEventCount
    + gardienPollVersion
  const handleReviewsChanged = useCallback(() => {
    setReviewListVersion((current) => current + 1)
  }, [])

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth))
  }, [sidebarWidth])

  useEffect(() => {
    let ignore = false
    void getSettings()
      .then((settings) => {
        if (ignore) return
        if (settings.actionFormat) {
          setActionFormat({ ...DEFAULT_ACTION_FORMAT, ...settings.actionFormat })
        }
        setConductorTokens(settings.conductorToolTokens ?? 0)
        setContextBaseline(settings.contextBaseline ?? 0)
      })
      // Les intitulés par défaut suffisent : un réglage illisible ne doit pas
      // priver le chat de ses cases à cocher.
      .catch(() => {})
    return () => {
      ignore = true
    }
  }, [])

  function handleSidebarResizeStart(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    event.preventDefault()

    const startX = event.clientX
    const startWidth = sidebarWidth
    document.body.classList.add('is-resizing-sidebar')

    function handlePointerMove(moveEvent: PointerEvent) {
      setSidebarWidth(clampSidebarWidth(startWidth + moveEvent.clientX - startX))
    }

    function handlePointerUp() {
      document.body.classList.remove('is-resizing-sidebar')
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
  }

  function handleSidebarResizeKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 32 : 12
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      setSidebarWidth((current) => clampSidebarWidth(current - step))
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      setSidebarWidth((current) => clampSidebarWidth(current + step))
    } else if (event.key === 'Home') {
      event.preventDefault()
      setSidebarWidth(MIN_SIDEBAR_WIDTH)
    } else if (event.key === 'End') {
      event.preventDefault()
      setSidebarWidth(MAX_SIDEBAR_WIDTH)
    }
  }

  useEffect(() => {
    const projectId = selectedProject?.id
    if (projectId === undefined) {
      setMcpServers([])
      return
    }
    const controller = new AbortController()
    void getProjectContextProfile(projectId, controller.signal)
      .then(setContextProfile)
      .catch(() => {})
    void listProjectMcpServers(projectId, controller.signal)
      .then((config) => {
        setMcpServers(config.servers)
        setMcpWeights(config.weights)
      })
      // L'inventaire MCP n'est qu'un confort d'affichage dans l'alerte.
      .catch(() => {})
    return () => controller.abort()
  }, [selectedProject?.id])

  useEffect(() => {
    function syncHelpHash() {
      const match = window.location.hash.match(/^#help\/([a-z0-9-]+)$/)
      if (!match) return
      setHelpSlug(match[1]!)
      setWorkspaceView('help')
    }
    syncHelpHash()
    window.addEventListener('hashchange', syncHelpHash)
    return () => window.removeEventListener('hashchange', syncHelpHash)
  }, [])

  function confirmLeaveMemory(): boolean {
    if (workspaceView !== 'memory' || !memoryDirty) return true
    if (!window.confirm('Abandonner les modifications mémoire non enregistrées ?')) return false
    setMemoryDirty(false)
    return true
  }

  useEffect(() => {
    if (!selectedProject?.id) return
    const projectId: string = selectedProject.id
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let previousSignature: string | null = null

    async function pollGardien() {
      try {
        const status = await getGardienStatus(projectId)
        if (disposed) return
        const signature = [
          status.mode,
          status.openFlagCount,
          status.openRedCount,
          status.pendingReviewCount,
        ].join(':')
        if (previousSignature !== null && signature !== previousSignature) {
          setGardienPollVersion((current) => current + 1)
        }
        previousSignature = signature
      } catch {
        // Les vues Gardien et Sidebar conservent leur propre affichage d'erreur.
      } finally {
        if (!disposed) timer = setTimeout(() => void pollGardien(), 1_500)
      }
    }

    void pollGardien()
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [selectedProject?.id])

  function handleProjectSelect(project: Project) {
    if (!confirmLeaveMemory()) return
    if (project.id !== selectedProject?.id) {
      setSelectedConversation(null)
      setNewConversationDraft('')
      setIsCreatingConversation(false)
      setShowSwitchModel(false)
      setShowReviewDialog(false)
      setWorkspaceView('conversations')
      setFocusedReviewId(null)
    }
    setSelectedProject(project)
  }

  function handleConversationSelect(conversation: Conversation) {
    if (!confirmLeaveMemory()) return
    setSelectedConversation(conversation)
    setNewConversationDraft('')
    setIsCreatingConversation(false)
    setShowSwitchModel(false)
    setShowReviewDialog(false)
    setWorkspaceView('conversations')
  }

  function handleConversationCreate() {
    if (!confirmLeaveMemory()) return
    if (selectedProject === null) return
    setSelectedConversation(null)
    setNewConversationDraft('')
    setIsCreatingConversation(true)
    setShowSwitchModel(false)
    setShowReviewDialog(false)
    setWorkspaceView('conversations')
  }

  function handleConversationClosed() {
    setSelectedConversation(null)
    setIsCreatingConversation(false)
    setConversationListVersion((current) => current + 1)
  }

  function handleConversationCreated(conversation: Conversation) {
    setSelectedConversation(conversation)
    setNewConversationDraft('')
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
    if (!confirmLeaveMemory()) return
    if (selectedProject === null) return
    setWorkspaceView('guardian')
    setShowSwitchModel(false)
    setShowReviewDialog(false)
  }

  function handleGitSelect() {
    if (!confirmLeaveMemory()) return
    if (selectedProject === null) return
    setWorkspaceView('git')
    setShowSwitchModel(false)
    setShowReviewDialog(false)
  }

  function handleCostsSelect() {
    if (!confirmLeaveMemory()) return
    if (selectedProject === null) return
    setWorkspaceView('costs')
    setShowSwitchModel(false)
    setShowReviewDialog(false)
  }

  function handleLibrarySelect() {
    if (!confirmLeaveMemory()) return
    setWorkspaceView('library')
    setShowSwitchModel(false)
    setShowReviewDialog(false)
  }

  function handleRoutinesSelect() {
    if (!confirmLeaveMemory()) return
    setWorkspaceView('routines')
    setShowSwitchModel(false)
    setShowReviewDialog(false)
  }

  function handleFleetSelect() {
    if (!confirmLeaveMemory()) return
    setWorkspaceView('fleet')
    setShowSwitchModel(false)
    setShowReviewDialog(false)
  }

  function handleMemorySelect() {
    setWorkspaceView('memory')
    setShowSwitchModel(false)
    setShowReviewDialog(false)
  }

  function handleHelpSelect(slug?: string) {
    if (!confirmLeaveMemory()) return
    const nextSlug = slug ?? helpSlug ?? 'gardien'
    setHelpSlug(nextSlug)
    setWorkspaceView('help')
    window.location.hash = `help/${nextSlug}`
    setShowSwitchModel(false)
    setShowReviewDialog(false)
  }

  function handleProgressSelect() {
    if (!confirmLeaveMemory()) return
    setWorkspaceView('progress')
    setShowSwitchModel(false)
    setShowReviewDialog(false)
  }

  function handleSettingsSelect() {
    if (!confirmLeaveMemory()) return
    setWorkspaceView('settings')
    setShowSwitchModel(false)
    setShowReviewDialog(false)
  }

  function handlePaletteViewSelect(view: 'fleet' | 'routines' | 'library' | 'memory' | 'help') {
    if (view === 'fleet') handleFleetSelect()
    else if (view === 'routines') handleRoutinesSelect()
    else if (view === 'library') handleLibrarySelect()
    else if (view === 'memory') handleMemorySelect()
    else handleHelpSelect()
  }

  function handlePaletteSkillLaunch(skill: SkillSummary) {
    if (!confirmLeaveMemory()) return
    if (!selectedProject) return
    setSelectedConversation(null)
    setNewConversationDraft(`$${skill.invocation} `)
    setIsCreatingConversation(true)
    setWorkspaceView('conversations')
  }

  async function handlePaletteAction(action: 'test' | 'debrief' | 'review') {
    if (!selectedConversation) return
    setWorkspaceView('conversations')
    if (action === 'review') {
      setShowReviewDialog(true)
      return
    }
    if (action === 'test') await createTestInventory(selectedConversation.id)
    else await createDebrief(selectedConversation.id)
  }

  async function handleRoutineConversationSelect(projectId: string, conversationId: string) {
    const project = selectedProject?.id === projectId
      ? selectedProject
      : listProjects().then((items) => items.find((item) => item.id === projectId) ?? null)
    const resolvedProject = await project
    if (!resolvedProject) return
    const conversations = await listProjectConversations(projectId)
    const conversation = conversations.find((item) => item.id === conversationId)
    if (!conversation) return
    setSelectedProject(resolvedProject)
    handleConversationSelect(conversation)
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

  const titlebarView = workspaceView === 'guardian'
    ? 'Gardien'
      : workspaceView === 'git'
        ? 'Git'
        : workspaceView === 'costs'
          ? 'Coûts'
      : workspaceView === 'library'
        ? 'Bibliothèque'
        : workspaceView === 'routines'
          ? 'Routines'
          : workspaceView === 'fleet'
            ? 'Fleet'
            : workspaceView === 'memory'
              ? 'Mémoire'
              : workspaceView === 'help'
                ? 'Aide'
                : workspaceView === 'progress'
                  ? 'Progression'
                  : workspaceView === 'settings'
                    ? 'Paramètres'
      : selectedConversation?.title ?? null

  return (
    <ActionFormatContext.Provider value={actionFormat}>
    <main
      className="app-shell"
      style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}
    >
      <Titlebar crumbs={[selectedProject?.name, titlebarView]} />
      <Sidebar
        selectedProject={selectedProject}
        selectedConversation={selectedConversation}
        onProjectSelect={handleProjectSelect}
        onConversationSelect={handleConversationSelect}
        onConversationCreate={handleConversationCreate}
        onConversationClosed={handleConversationClosed}
        conversationListVersion={conversationListVersion}
        projectListVersion={projectListVersion}
        quotas={quotas}
        runningSubtasks={runningSubtasks}
        workspaceView={workspaceView}
        onGuardianSelect={handleGuardianSelect}
        onGitSelect={handleGitSelect}
        onCostsSelect={handleCostsSelect}
        onLibrarySelect={handleLibrarySelect}
        onRoutinesSelect={handleRoutinesSelect}
        onFleetSelect={handleFleetSelect}
        onPaletteSelect={() => setPaletteOpen(true)}
        onMemorySelect={handleMemorySelect}
        onHelpSelect={() => handleHelpSelect()}
        onProgressSelect={handleProgressSelect}
        onSettingsSelect={handleSettingsSelect}
        gamification={gamification.snapshot}
        xpPulse={gamification.xpPulse}
        reviewListVersion={effectiveReviewListVersion}
      />
      <div
        className="sidebar-resize-handle"
        role="separator"
        aria-label="Redimensionner la barre latérale"
        aria-orientation="vertical"
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuemax={MAX_SIDEBAR_WIDTH}
        aria-valuenow={sidebarWidth}
        tabIndex={0}
        title="Glisser pour redimensionner · double-cliquer pour réinitialiser"
        onPointerDown={handleSidebarResizeStart}
        onKeyDown={handleSidebarResizeKeyDown}
        onDoubleClick={() => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
      >
        <span aria-hidden="true" />
      </div>

      <section className="workspace" aria-label={workspaceView === 'guardian' ? 'Gardien' : workspaceView === 'git' ? 'Git' : workspaceView === 'costs' ? 'Coûts' : workspaceView === 'library' ? 'Bibliothèque' : workspaceView === 'routines' ? 'Routines' : workspaceView === 'fleet' ? 'Fleet' : workspaceView === 'memory' ? 'Mémoire' : workspaceView === 'help' ? 'Aide' : workspaceView === 'progress' ? 'Progression' : workspaceView === 'settings' ? 'Paramètres' : 'Conversation'}>
        {workspaceView === 'library' ? (
          <SkillsLibrary project={selectedProject} />
        ) : workspaceView === 'routines' ? (
          <RoutinesView
            initialProject={selectedProject}
            onConversationSelect={(projectId, conversationId) => void handleRoutineConversationSelect(projectId, conversationId)}
          />
        ) : workspaceView === 'fleet' ? (
          <FleetView
            onConversationSelect={(projectId, conversationId) => void handleRoutineConversationSelect(projectId, conversationId)}
          />
        ) : workspaceView === 'memory' ? (
          <MemoryView onDirtyChange={setMemoryDirty} />
        ) : workspaceView === 'help' ? (
          <HelpView key={helpSlug ?? 'index'} initialSlug={helpSlug} />
        ) : workspaceView === 'progress' ? (
          <ProgressView snapshot={gamification.snapshot} />
        ) : workspaceView === 'settings' ? (
          <AppSettingsView />
        ) : selectedProject === null ? (
          <div className="empty-state">
            <p>Sélectionnez un projet pour commencer.</p>
          </div>
        ) : workspaceView === 'guardian' ? (
          <GuardianView
            key={`${selectedProject.id}-${focusedReviewId ?? 'latest'}`}
            project={selectedProject}
            initialReviewId={focusedReviewId}
            refreshToken={effectiveReviewListVersion}
            onProjectUpdated={handleProjectUpdated}
            onReviewsChanged={handleReviewsChanged}
            onStartReview={selectedConversation ? () => setShowReviewDialog(true) : undefined}
          />
        ) : workspaceView === 'git' ? (
          <GitView
            project={selectedProject}
            onConversationSelect={(conversationId) => void handleGitConversationSelect(conversationId)}
            onGuardianSelect={handleGitGuardianSelect}
          />
        ) : workspaceView === 'costs' ? (
          <CostsView
            project={selectedProject}
            onConversationSelect={(conversationId) => void handleGitConversationSelect(conversationId)}
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
                    {selectedConversation.provider} · {modelLabel(selectedConversation.model)} ·{' '}
                    {selectedConversation.effort ?? 'default'}
                    {selectedConversation.speed === 'fast' ? ' · rapide' : ''}
                  </p>
                ) : null}
                {selectedConversation !== null ? (
                  <ContextGauge
                    conversation={selectedConversation}
                    events={events}
                    conductorTokens={conductorTokens}
                    contextBaseline={contextBaseline}
                    contextProfile={contextProfile}
                    mcpServers={mcpServers}
                    mcpWeights={mcpWeights}
                    onOpenProjectSettings={() => setProjectSettingsOpen(true)}
                    onHandoffSuggested={() => setShowSwitchModel(true)}
                  />
                ) : null}
              </div>
              {selectedConversation !== null ? (
                <div className="header-actions">
                  <ResumeCommandButton conversation={selectedConversation} />
                  <button
                    type="button"
                    className="header-action"
                    onClick={() => setShowReviewDialog(true)}
                    title="Analyser le dernier diff Git avec un modèle fort"
                  >
                    Review Gardien
                  </button>
                  <details className="header-action-menu">
                    <summary className="header-action header-action-icon" title="Actions de la conversation">
                      <span aria-hidden="true">⋯</span>
                      <span className="sr-only">Actions de la conversation</span>
                    </summary>
                    <div role="menu">
                      <button type="button" role="menuitem" onClick={() => setShowSwitchModel(true)}>
                        Changer de modèle
                      </button>
                      <button type="button" role="menuitem" onClick={() => setShowReviewDialog(true)}>
                        Ouvrir Gardien
                      </button>
                    </div>
                  </details>
                </div>
              ) : null}
            </header>
            <Chat
              key={selectedConversation === null
                ? `chat-new-${selectedProject.id}-${newConversationDraft}`
                : `chat-${selectedConversation.id}`}
              events={selectedConversation === null ? [] : events}
              connection={connection}
              retryAt={retryAt}
              conversation={selectedConversation}
              project={selectedProject}
              quotas={quotas.snapshot}
              onConversationCreated={handleConversationCreated}
              onProjectUpdated={handleProjectUpdated}
              onRunningSubtasksChange={setRunningSubtasks}
              initialMessage={newConversationDraft}
            />
            {showSwitchModel && selectedConversation !== null ? (
              <SwitchModelModal
                key={`switch-model-${selectedConversation.id}`}
                conversation={selectedConversation}
                events={events}
                onClose={() => setShowSwitchModel(false)}
                onSwitched={handleConversationSwitched}
                onHandoff={handleConversationHandoff}
              />
            ) : null}
            {showReviewDialog && selectedConversation !== null ? (
              <ReviewDialog
                key={`review-${selectedConversation.id}`}
                conversation={selectedConversation}
                project={selectedProject}
                onClose={() => setShowReviewDialog(false)}
                onStarted={handleReviewStarted}
              />
            ) : null}
          </>
        )}
      </section>
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        currentProject={selectedProject}
        currentConversation={selectedConversation}
        onProjectSelect={handleProjectSelect}
        onConversationSelect={(projectId, conversationId) => handleRoutineConversationSelect(projectId, conversationId)}
        onSkillLaunch={handlePaletteSkillLaunch}
        onViewSelect={handlePaletteViewSelect}
        onAction={handlePaletteAction}
      />
      {projectSettingsOpen && selectedProject ? (
        <ProjectSettingsDialog
          project={selectedProject}
          onClose={() => setProjectSettingsOpen(false)}
          onUpdated={handleProjectUpdated}
        />
      ) : null}
    </main>
    </ActionFormatContext.Provider>
  )
}

export default App
