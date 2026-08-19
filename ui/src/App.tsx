import { useEffect, useState } from 'react'
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react'
import { Chat } from './Chat'
import { Sidebar } from './Sidebar'
import { Rail } from './Rail'
import { Titlebar } from './Titlebar'
import { SwitchModelModal } from './SwitchModelModal'
import { HandoffModal } from './HandoffModal'
import type { Attachment, Conversation, DocumentArtifact, Project } from './types'
import { useConversationEvents } from './useConversationEvents'
import { useQuotas } from './useQuotas'
import { ContextGauge } from './ContextGauge'
import { GitView } from './GitView'
import {
  getProjectContextProfile,
  getSettings,
  listProjectConversations,
  listProjectMcpServers,
  listProjects,
  markConversationRead,
} from './api'
import type { ContextProfile, McpServerRef } from './api'
import { ActionFormatContext, DEFAULT_ACTION_FORMAT } from './actionHeadings'
import { modelLabel } from './modelOptions'
import { ProviderMark } from './ProviderMark'
import type { ActionFormat } from './actionHeadings'
import { SkillsLibrary } from './SkillsLibrary'
import { RoutinesView } from './RoutinesView'
import { useAppNotifications } from './useAppNotifications'
import { FleetView } from './FleetView'
import { CommandPalette } from './CommandPalette'
import { createSessionSummary, createTestInventory, startReview } from './api'
import type { SkillSummary } from './types'
import { CostsView } from './CostsView'
import { MemoryView } from './MemoryView'
import { ResumeCommandButton } from './ResumeCommandButton'
import { HelpView } from './HelpView'
import type { AppEvent, WorkspaceView } from './types'
import { useGamification } from './useGamification'
import { complexityMultiplier } from './turnXp'
import { useFleet } from './useFleet'
import { countConversationMessages } from './conversationMessageCount'
import { ProgressView } from './ProgressView'
import { AppSettingsView } from './AppSettingsView'
import { ProjectSettingsDialog } from './ProjectSettingsDialog'
import { DocumentsView } from './DocumentsView'
import { DesignView } from './DesignView'
import { DashboardView } from './DashboardView'
import { branchOfWorktree } from './conversationBranch'
import { BranchIcon } from './BranchIcon'
import { SurfaceSwitch } from './SurfaceSwitch'
import { isAppRestartShortcut, restartApp } from './appRestart'
import {
  locationForSelection,
  readLastActiveLocation,
  restoreConversation,
  restoreProject,
  writeLastActiveLocation,
} from './restoreLocation'

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
  const [newConversationAttachments, setNewConversationAttachments] = useState<Attachment[]>([])
  const [conversationListVersion, setConversationListVersion] = useState(0)
  const [railReadVersion, setRailReadVersion] = useState(0)
  const [projectListVersion, setProjectListVersion] = useState(0)
  const [showSwitchModel, setShowSwitchModel] = useState(false)
  const [showHandoff, setShowHandoff] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [helpSlug, setHelpSlug] = useState<string | null>(null)
  const [memoryDirty, setMemoryDirty] = useState(false)
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>('conversations')
  const [focusedFlagId, setFocusedFlagId] = useState<string | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(storedSidebarWidth)
  const [locationRestored, setLocationRestored] = useState(false)
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
  const [restartStatus, setRestartStatus] = useState<'idle' | 'running' | 'error'>('idle')
  const { events, connection, retryAt } = useConversationEvents(
    workspaceView === 'conversations' ? selectedConversation?.id ?? null : null,
  )
  const liveConversationMessageCount = events.length > 0
    ? countConversationMessages(events)
    : undefined
  const quotas = useQuotas()
  const gamification = useGamification()
  const fleet = useFleet(selectedProject?.id)
  useAppNotifications()

  useEffect(() => {
    function handleRestartShortcut(event: KeyboardEvent) {
      if (!isAppRestartShortcut(event) || restartStatus === 'running') return
      event.preventDefault()
      setRestartStatus('running')
      void restartApp().catch(() => setRestartStatus('error'))
    }
    window.addEventListener('keydown', handleRestartShortcut)
    return () => window.removeEventListener('keydown', handleRestartShortcut)
  }, [restartStatus])
  // Le digest est régénéré côté sidecar après un tour : on rafraîchit le titre
  // affiché sans recharger la conversation.
  const digest = lastDigest(events)
  const digestTitle = digest?.title
  const digestSummary = digest?.summary
  const selectedConversationId = selectedConversation?.id
  const selectedConversationDigestTurn = selectedConversation?.digest_turn
  const selectedConversationLastReadTurn = selectedConversation?.last_read_turn ?? 0
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

  useEffect(() => {
    if (workspaceView !== 'conversations' || selectedConversationId === undefined || selectedConversationDigestTurn === undefined) return
    if (selectedConversationDigestTurn <= selectedConversationLastReadTurn) return
    setSelectedConversation((current) => current === null
      ? current
      : { ...current, last_read_turn: Math.max(current.last_read_turn ?? 0, selectedConversationDigestTurn) })
    void markConversationRead(selectedConversationId, selectedConversationDigestTurn)
      .then(() => setRailReadVersion((current) => current + 1))
      .catch(() => {})
  }, [workspaceView, selectedConversationId, selectedConversationDigestTurn, selectedConversationLastReadTurn])
  const reviewOpenCount = fleet.reviewStatus
    ? fleet.reviewStatus.openBySeverity.red + fleet.reviewStatus.openBySeverity.orange + fleet.reviewStatus.openBySeverity.grey
    : 0

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

  useEffect(() => {
    let ignore = false
    const savedLocation = readLastActiveLocation(window.localStorage)
    if (savedLocation === null) {
      setLocationRestored(true)
      return () => {
        ignore = true
      }
    }

    void listProjects()
      .then(async (projects) => {
        if (ignore) return
        const project = restoreProject(projects, savedLocation)
        if (project === null) {
          setLocationRestored(true)
          return
        }

        setSelectedProject(project)
        const rememberedProjectStillExists = project.id === savedLocation.projectId
        try {
          const conversations = await listProjectConversations(project.id)
          if (ignore) return
          setSelectedConversation(restoreConversation(
            conversations,
            rememberedProjectStillExists ? savedLocation.conversationId : null,
          ))
        } catch {
          // La sidebar gère son propre chargement ; le projet reste restauré.
        }
        if (!ignore) setLocationRestored(true)
      })
      .catch(() => {
        if (!ignore) setLocationRestored(true)
      })

    return () => {
      ignore = true
    }
  }, [])

  useEffect(() => {
    if (!locationRestored) return
    const location = locationForSelection(selectedProject, selectedConversation)
    if (location !== null) writeLastActiveLocation(window.localStorage, location)
  }, [
    locationRestored,
    selectedProject?.id,
    selectedConversation?.id,
    selectedConversation?.project_id,
  ])

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

  function handleProjectSelect(project: Project) {
    if (!confirmLeaveMemory()) return
    if (project.id !== selectedProject?.id) {
      setSelectedConversation(null)
      setNewConversationDraft('')
      setNewConversationAttachments([])
      setIsCreatingConversation(false)
      setShowSwitchModel(false)
    }
    // Cliquer un avatar de projet dans le rail ramène toujours à ses
    // conversations, même si le projet était déjà sélectionné.
    setWorkspaceView('conversations')
    setSelectedProject(project)
  }

  function handleConversationSelect(conversation: Conversation) {
    if (!confirmLeaveMemory()) return
    setSelectedConversation(conversation)
    setNewConversationDraft('')
    setNewConversationAttachments([])
    setIsCreatingConversation(false)
    setShowSwitchModel(false)
    setWorkspaceView('conversations')
  }

  function handleConversationCreate() {
    if (!confirmLeaveMemory()) return
    if (selectedProject === null) return
    setSelectedConversation(null)
    setNewConversationDraft('')
    setNewConversationAttachments([])
    setIsCreatingConversation(true)
    setShowSwitchModel(false)
    setWorkspaceView('conversations')
  }

  function handleConversationClosed() {
    setSelectedConversation(null)
    setIsCreatingConversation(false)
    setConversationListVersion((current) => current + 1)
  }

  function handleConversationRead() {
    if (selectedConversation === null) return
    const lastReadTurn = selectedConversation.digest_turn
    if (lastReadTurn <= (selectedConversation.last_read_turn ?? 0)) return
    setSelectedConversation((current) => current === null
      ? current
      : { ...current, last_read_turn: Math.max(current.last_read_turn ?? 0, lastReadTurn) })
    void markConversationRead(selectedConversation.id, lastReadTurn)
      .then(() => setRailReadVersion((current) => current + 1))
      .catch(() => {})
  }

  function handleConversationCreated(conversation: Conversation) {
    setSelectedConversation(conversation)
    setNewConversationDraft('')
    setNewConversationAttachments([])
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
    setShowHandoff(false)
    setConversationListVersion((current) => current + 1)
  }

  function handleGitSelect(flagId?: string) {
    if (!confirmLeaveMemory()) return
    if (selectedProject === null) return
    setFocusedFlagId(flagId ?? null)
    setWorkspaceView('git')
    setShowSwitchModel(false)
  }

  function handleCostsSelect() {
    if (!confirmLeaveMemory()) return
    if (selectedProject === null) return
    setWorkspaceView('costs')
    setShowSwitchModel(false)
  }

  function handleDashboardSelect() {
    if (!confirmLeaveMemory()) return
    if (selectedProject === null) return
    setWorkspaceView('dashboard')
    setShowSwitchModel(false)
  }

  function handleDocumentsSelect() {
    if (!confirmLeaveMemory()) return
    setWorkspaceView('documents')
    setShowSwitchModel(false)
  }

  function handleConversationsSelect() {
    if (!confirmLeaveMemory()) return
    setWorkspaceView('conversations')
    setShowSwitchModel(false)
  }

  function handleLibrarySelect() {
    if (!confirmLeaveMemory()) return
    setWorkspaceView('library')
    setShowSwitchModel(false)
  }

  function handleRoutinesSelect() {
    if (!confirmLeaveMemory()) return
    setWorkspaceView('routines')
    setShowSwitchModel(false)
  }

  function handleFleetSelect() {
    if (!confirmLeaveMemory()) return
    setWorkspaceView('fleet')
    setShowSwitchModel(false)
  }

  function handleDesignSelect() {
    if (!confirmLeaveMemory()) return
    setWorkspaceView('design')
    setShowSwitchModel(false)
  }

  function handleMemorySelect() {
    setWorkspaceView('memory')
    setShowSwitchModel(false)
  }

  function handleHelpSelect(slug?: string) {
    if (!confirmLeaveMemory()) return
    const nextSlug = slug ?? helpSlug ?? 'gardien'
    setHelpSlug(nextSlug)
    setWorkspaceView('help')
    window.location.hash = `help/${nextSlug}`
    setShowSwitchModel(false)
  }

  function handleProgressSelect() {
    if (!confirmLeaveMemory()) return
    setWorkspaceView('progress')
    setShowSwitchModel(false)
  }

  function handleSettingsSelect() {
    if (!confirmLeaveMemory()) return
    setWorkspaceView('settings')
    setShowSwitchModel(false)
  }

  function handlePaletteViewSelect(view: 'fleet' | 'routines' | 'documents' | 'library' | 'memory' | 'help' | 'dashboard') {
    if (view === 'dashboard') handleDashboardSelect()
    else if (view === 'fleet') handleFleetSelect()
    else if (view === 'routines') handleRoutinesSelect()
    else if (view === 'documents') handleDocumentsSelect()
    else if (view === 'library') handleLibrarySelect()
    else if (view === 'memory') handleMemorySelect()
    else handleHelpSelect()
  }

  function handlePaletteSkillLaunch(skill: SkillSummary) {
    if (!confirmLeaveMemory()) return
    if (!selectedProject) return
    setSelectedConversation(null)
    setNewConversationDraft(`$${skill.invocation} `)
    setNewConversationAttachments([])
    setIsCreatingConversation(true)
    setWorkspaceView('conversations')
  }

  async function handlePaletteAction(action: 'test' | 'summary' | 'review') {
    if (!selectedConversation) return
    if (action === 'review') {
      await startReview({ conversationId: selectedConversation.id, scope: 'worktree' })
      handleGitSelect()
      return
    }
    setWorkspaceView('conversations')
    if (action === 'test') await createTestInventory(selectedConversation.id)
    else await createSessionSummary(selectedConversation.id)
  }

  async function startWorktreeReview() {
    if (!selectedConversation) return
    await startReview({ conversationId: selectedConversation.id, scope: 'worktree' })
    handleGitSelect()
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

  async function handleDocumentUse(
    projectId: string,
    attachment: Attachment,
    document: DocumentArtifact,
  ) {
    const projects = await listProjects()
    const project = projects.find((item) => item.id === projectId)
    if (!project) return
    setSelectedProject(project)
    setSelectedConversation(null)
    setNewConversationDraft(`Utilise le document joint « ${document.title} » comme contexte pour cette nouvelle conversation.`)
    setNewConversationAttachments([attachment])
    setIsCreatingConversation(true)
    setShowSwitchModel(false)
    setWorkspaceView('conversations')
  }

  async function handleGitConversationSelect(conversationId: string) {
    if (selectedProject === null) return
    const conversations = await listProjectConversations(selectedProject.id)
    const conversation = conversations.find((item) => item.id === conversationId)
    if (conversation) handleConversationSelect(conversation)
  }

  const titlebarView = workspaceView === 'conversations'
    ? selectedConversation?.title ?? null
    : {
        git: 'Git',
        documents: 'Documents',
        design: 'Claude Design',
        dashboard: 'Tableau de bord',
        costs: 'Coûts',
        library: 'Skills',
        routines: 'Routines',
        fleet: 'Fleet',
        memory: 'Mémoire',
        help: 'Aide',
        progress: 'Progression',
        settings: 'Paramètres',
      }[workspaceView]

  // Git est un calque de la conversation ouverte, pas une destination qui la
  // remplace : sa liste reste visible pour préserver le contexte de travail.
  const showSidebar = workspaceView === 'conversations'
    || (workspaceView === 'git' && selectedConversation !== null)

  return (
    <ActionFormatContext.Provider value={actionFormat}>
    {/* Le rail se déplie normalement par-dessus la zone de contenu, sans la
        refluer. Impossible dans la vue Design : le panneau est une webview, une
        surface de l'OS, et elle se dessine au-dessus du DOM, donc le rail déplié
        passerait derrière elle et se retrouverait tronqué. On lui donne sa
        largeur dépliée en dur dans cette vue, et il cesse de déborder. */}
    <main
      className={`app-shell ${showSidebar ? '' : 'app-shell--no-sidebar'}${
        workspaceView === 'design' ? ' app-shell--pinned-rail' : ''
      }`}
      style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}
    >
      <Titlebar
        crumbs={[selectedProject?.name, titlebarView]}
        onSearch={() => setPaletteOpen(true)}
        gamification={gamification.snapshot}
      />
      <Rail
        selectedProject={selectedProject}
        projectListVersion={projectListVersion}
        conversationListVersion={conversationListVersion + railReadVersion}
        onProjectSelect={handleProjectSelect}
        onProjectCreated={handleProjectSelect}
        workspaceView={workspaceView}
        onConversationsSelect={handleConversationsSelect}
        onDashboardSelect={handleDashboardSelect}
        onGitSelect={handleGitSelect}
        onDocumentsSelect={handleDocumentsSelect}
        onDesignSelect={handleDesignSelect}
        onCostsSelect={handleCostsSelect}
        onLibrarySelect={handleLibrarySelect}
        onRoutinesSelect={handleRoutinesSelect}
        onFleetSelect={handleFleetSelect}
        onMemorySelect={handleMemorySelect}
        onHelpSelect={() => handleHelpSelect()}
        onProgressSelect={handleProgressSelect}
        onSettingsSelect={handleSettingsSelect}
        pendingReviews={reviewOpenCount}
        fleetActive={fleet.items.length}
        activeProjectIds={[...new Set(fleet.items.map((item) => item.projectId))]}
      />
      {showSidebar ? (
      <>
      <Sidebar
        selectedProject={selectedProject}
        selectedConversation={selectedConversation}
        onProjectSelect={handleProjectSelect}
        onConversationSelect={handleConversationSelect}
        onConversationCreate={handleConversationCreate}
        onConversationClosed={handleConversationClosed}
        onConversationRead={() => setRailReadVersion((current) => current + 1)}
        conversationListVersion={conversationListVersion}
        quotas={quotas}
        runningSubtasks={runningSubtasks}
        liveConversationMessageCount={liveConversationMessageCount}
        workspaceView={workspaceView}
        onProgressSelect={handleProgressSelect}
        gamification={gamification.snapshot}
        xpPulse={gamification.xpPulse}
        activeFleet={fleet.items}
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
      </>
      ) : null}

      <section className="workspace" aria-label={titlebarView ?? 'Conversation'}>
        {workspaceView === 'documents' ? (
          <DocumentsView
            currentProject={selectedProject}
            onConversationSelect={(projectId, conversationId) => void handleRoutineConversationSelect(projectId, conversationId)}
            onUseInConversation={(projectId, attachment, document) => void handleDocumentUse(projectId, attachment, document)}
          />
        ) : workspaceView === 'design' ? (
          <DesignView />
        ) : workspaceView === 'library' ? (
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
        ) : workspaceView === 'dashboard' ? (
          <DashboardView
            project={selectedProject}
            onConversationSelect={(conversationId) => void handleGitConversationSelect(conversationId)}
            onStartConversation={() => {}}
            onOpenSettings={() => setProjectSettingsOpen(true)}
          />
        ) : workspaceView === 'git' ? (
          <GitView
            project={selectedProject}
            conversation={selectedConversation}
            focusedFlagId={focusedFlagId}
            reviewStatus={fleet.reviewStatus}
            onConversationBack={handleConversationsSelect}
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
              <div className="conversation-title-block">
                <div className="conversation-title-row">
                  <h1>{selectedConversation?.title ?? 'Nouvelle conversation'}</h1>
                  {selectedConversation !== null
                  && gamification.snapshot?.conversations[selectedConversation.id] ? (
                    <span
                      className="conversation-title-complexity"
                      title={`${gamification.snapshot.conversations[selectedConversation.id].commits} commit(s) · ×${gamification.snapshot.conversations[selectedConversation.id].multiplier.toLocaleString('fr-FR')}`}
                    >
                      C{gamification.snapshot.conversations[selectedConversation.id].complexity}
                    </span>
                  ) : null}
                </div>
                {selectedConversation !== null ? (
                  <p>
                    <ProviderMark provider={selectedConversation.provider} className="conversation-prov" />
                    {modelLabel(selectedConversation.model)} ·{' '}
                    {selectedConversation.effort ?? 'default'}
                    {selectedConversation.speed === 'fast' ? ' · rapide' : ''}
                    {branchOfWorktree(selectedConversation.worktree_path) !== null ? (
                      <span
                        className="conversation-branch"
                        title={`Worktree dédié : ${selectedConversation.worktree_path}`}
                      >
                        <BranchIcon />
                        {branchOfWorktree(selectedConversation.worktree_path)}
                      </span>
                    ) : null}
                  </p>
                ) : null}
              </div>
              {selectedConversation !== null ? (
                <SurfaceSwitch
                  active="conversation"
                  onConversation={handleConversationsSelect}
                  onCode={() => handleGitSelect()}
                />
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
                  onHandoff={() => setShowHandoff(true)}
                />
              ) : null}
              {selectedConversation !== null ? (
                <div className="header-actions">
                  <button
                    type="button"
                    className="header-action header-action-icon"
                    onClick={() => handleGitSelect()}
                    title="Afficher le code et les reviews"
                    aria-label="Afficher le code"
                  >
                    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path d="M8 2 13 4v4c0 3-2 5-5 6-3-1-5-3-5-6V4l5-2Z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
                    </svg>
                  </button>
                  <ResumeCommandButton conversation={selectedConversation} />
                  <details className="header-action-menu">
                    <summary className="header-action header-action-icon" title="Actions de la conversation">
                      <span aria-hidden="true">⋯</span>
                      <span className="sr-only">Actions de la conversation</span>
                    </summary>
                    <div role="menu">
                      <button type="button" role="menuitem" onClick={() => setShowSwitchModel(true)}>
                        Changer de modèle
                      </button>
                      <button type="button" role="menuitem" onClick={() => void startWorktreeReview()}>
                        Relire le diff
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
              onConversationRead={handleConversationRead}
              onRunningSubtasksChange={setRunningSubtasks}
              initialMessage={newConversationDraft}
              initialAttachments={newConversationAttachments}
              turnXpMultiplier={complexityMultiplier(
                (selectedConversation
                  ? gamification.snapshot?.conversations[selectedConversation.id]?.complexity
                  : undefined) ?? 0,
              ) * (gamification.snapshot?.focusMultiplier ?? 1)}
              reviewStatus={fleet.reviewStatus}
              onOpenCode={handleGitSelect}
            />
            {showSwitchModel && selectedConversation !== null ? (
              <SwitchModelModal
                key={`switch-model-${selectedConversation.id}`}
                conversation={selectedConversation}
                events={events}
                project={selectedProject}
                quotas={quotas.snapshot}
                onProjectUpdated={handleProjectUpdated}
                onClose={() => setShowSwitchModel(false)}
                onSwitched={handleConversationSwitched}
                onHandoff={handleConversationHandoff}
              />
            ) : null}
            {showHandoff && selectedConversation !== null ? (
              <HandoffModal
                key={`handoff-${selectedConversation.id}`}
                conversation={selectedConversation}
                onClose={() => setShowHandoff(false)}
                onCreated={handleConversationHandoff}
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
      {restartStatus !== 'idle' ? (
        <div className={`app-restart-status ${restartStatus === 'error' ? 'is-error' : ''}`} role={restartStatus === 'error' ? 'alert' : 'status'}>
          <span aria-hidden="true">{restartStatus === 'error' ? '×' : '↻'}</span>
          <span>{restartStatus === 'error' ? 'Redémarrage impossible · réessaie avec Ctrl+Maj+R' : 'Redémarrage de Pupitre…'}</span>
        </div>
      ) : null}
    </main>
    </ActionFormatContext.Provider>
  )
}

export default App
