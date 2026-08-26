import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
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
import type { ChangelogReview } from './types'
import { useConversationEvents } from './useConversationEvents'
import { useQuotas } from './useQuotas'
import {
  getSettings,
  getPendingChangelogReview,
  listProjectConversations,
  listProjects,
  markConversationRead,
  setAppVisibility,
} from './api'
import { ActionFormatContext, DEFAULT_ACTION_FORMAT } from './actionHeadings'
import type { ActionFormat } from './actionHeadings'
import { useAppNotifications } from './useAppNotifications'
import { CommandPalette } from './CommandPalette'
import { createSessionSummary, createTestInventory, startReview } from './api'
import type { SkillSummary } from './types'
import { ResumeCommandButton } from './ResumeCommandButton'
import type { AppEvent, WorkspaceView } from './types'
import { useTimeTracking } from './useTimeTracking'
import { useFleet } from './useFleet'
import { countConversationMessages } from './conversationMessageCount'
import { ProjectSettingsDialog } from './ProjectSettingsDialog'
import { branchOfWorktree } from './conversationBranch'
import { BranchIcon } from './BranchIcon'
import { ConversationInstruction } from './ConversationInstruction'
import { SentryLinkIcon, TicketLinkIcons } from './TicketLinkIcons'
import { useSentryLinks, useTicketLinks } from './ticketLinks'
import { isAppRestartShortcut, restartApp } from './appRestart'
import { ChangelogReviewDialog } from './ChangelogReviewDialog'
import {
  locationForSelection,
  readLastActiveLocation,
  restoreConversation,
  restoreProject,
  writeLastActiveLocation,
} from './restoreLocation'

const SkillsLibrary = lazy(() => import('./SkillsLibrary').then((module) => ({ default: module.SkillsLibrary })))
const RoutinesView = lazy(() => import('./RoutinesView').then((module) => ({ default: module.RoutinesView })))
const FleetView = lazy(() => import('./FleetView').then((module) => ({ default: module.FleetView })))
const CostsView = lazy(() => import('./CostsView').then((module) => ({ default: module.CostsView })))
const MemoryView = lazy(() => import('./MemoryView').then((module) => ({ default: module.MemoryView })))
const HelpView = lazy(() => import('./HelpView').then((module) => ({ default: module.HelpView })))
const ProgressView = lazy(() => import('./ProgressView').then((module) => ({ default: module.ProgressView })))
const AppSettingsView = lazy(() => import('./AppSettingsView').then((module) => ({ default: module.AppSettingsView })))
const DocumentsView = lazy(() => import('./DocumentsView').then((module) => ({ default: module.DocumentsView })))
const DesignView = lazy(() => import('./DesignView').then((module) => ({ default: module.DesignView })))
const DashboardView = lazy(() => import('./DashboardView').then((module) => ({ default: module.DashboardView })))

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
function lastDigest(events: AppEvent[]): Extract<AppEvent, { type: 'conversation-digest' }> | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type === 'conversation-digest') {
      return event
    }
  }
  return null
}

function App() {
  useEffect(() => {
    const reportVisibility = () => {
      void setAppVisibility(document.visibilityState === 'visible').catch(() => {})
    }
    reportVisibility()
    document.addEventListener('visibilitychange', reportVisibility)
    return () => document.removeEventListener('visibilitychange', reportVisibility)
  }, [])
  const [selectedProject, setSelectedProject] = useState<Project | null>(null)
  const [selectedConversation, setSelectedConversation] =
    useState<Conversation | null>(null)
  const [isCreatingConversation, setIsCreatingConversation] = useState(false)
  const [conversationSeed, setConversationSeed] = useState<{
    ticketId?: string | null
    ticketKey?: string | null
    branch: string | null
    originType?: 'sentry' | null
    originKey?: string | null
  } | null>(null)
  const [newConversationDraft, setNewConversationDraft] = useState('')
  const [newConversationAttachments, setNewConversationAttachments] = useState<Attachment[]>([])
  const [conversationListVersion, setConversationListVersion] = useState(0)
  const [railReadVersion, setRailReadVersion] = useState(0)
  const readSyncKeyRef = useRef<string | null>(null)
  const [projectListVersion, setProjectListVersion] = useState(0)
  const [showSwitchModel, setShowSwitchModel] = useState(false)
  const [showHandoff, setShowHandoff] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [helpSlug, setHelpSlug] = useState<string | null>(null)
  const [memoryDirty, setMemoryDirty] = useState(false)
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>('conversations')
  const [sidebarWidth, setSidebarWidth] = useState(storedSidebarWidth)
  const [locationRestored, setLocationRestored] = useState(false)
  // Décision D1 : l'info « sous-tâches en vol » vit dans le fil de la
  // conversation ouverte — la sidebar n'en affiche l'indicateur que pour elle.
  const [runningSubtasks, setRunningSubtasks] = useState(0)
  // Intitulés reconnus pour les blocs d'actions : chargés une fois, diffusés à
  // tout le rendu Markdown.
  const [actionFormat, setActionFormat] = useState<ActionFormat>(DEFAULT_ACTION_FORMAT)
  /** Configuration du projet ouverte depuis le diagnostic de contexte. */
  const [projectSettingsOpen, setProjectSettingsOpen] = useState(false)
  const [restartStatus, setRestartStatus] = useState<'idle' | 'running' | 'error'>('idle')
  const [changelogReview, setChangelogReview] = useState<ChangelogReview | null>(null)
  const [pendingChangelogReview, setPendingChangelogReview] = useState<ChangelogReview | null>(null)
  const { events, connection, retryAt } = useConversationEvents(
    workspaceView === 'conversations' ? selectedConversation?.id ?? null : null,
  )
  const liveConversationMessageCount = events.length > 0
    ? countConversationMessages(events)
    : undefined
  const quotas = useQuotas()
  // La Progression est une vue globale : on y lit tous les projets, et le
  // temps passé à consulter ses propres chiffres n'est imputé à aucun d'eux.
  const time = useTimeTracking(
    workspaceView === 'progress' ? null : selectedProject?.id ?? null,
    workspaceView === 'progress' ? null : selectedConversation?.id ?? null,
  )
  const fleet = useFleet(selectedProject?.id)
  const ticketLinks = useTicketLinks(selectedProject?.id)
  const sentryLinks = useSentryLinks(selectedProject?.id)
  useAppNotifications()

  useEffect(() => {
    let ignore = false
    if (!selectedConversation?.id) {
      setPendingChangelogReview(null)
      return
    }
    void getPendingChangelogReview(selectedConversation.id)
      .then((review) => { if (!ignore) setPendingChangelogReview(review) })
      .catch(() => { if (!ignore) setPendingChangelogReview(null) })
    return () => { ignore = true }
  }, [selectedConversation?.id])

  function handleChangelogReview(review: ChangelogReview) {
    setPendingChangelogReview(review)
    setChangelogReview(review)
  }

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
  const answeredCount = useMemo(
    () => events.reduce(
      (total, event) => event.type === 'status' && event.state !== 'running' ? total + 1 : total,
      0,
    ),
    [events],
  )
  const digestTitle = digest?.title
  const digestSummary = digest?.summary
  const digestDomains = digest?.domains
  const digestProposedDomainCount = digest?.proposedDomainCount
  const selectedConversationId = selectedConversation?.id
  const selectedConversationAnsweredTurn = selectedConversation?.answered_turn ?? 0
  const selectedConversationLastReadTurn = selectedConversation?.last_read_turn ?? 0
  useEffect(() => {
    if (digestTitle === undefined || digestSummary === undefined) return
    setSelectedConversation((current) =>
      current === null
        ? current
        : {
            ...current,
            title: digestTitle,
            summary: digestSummary,
            domains: digestDomains ?? current.domains,
            proposed_domain_count: digestProposedDomainCount ?? current.proposed_domain_count,
          },
    )
    setConversationListVersion((current) => current + 1)
  }, [digestTitle, digestSummary, digestDomains, digestProposedDomainCount])

  useEffect(() => {
    if (workspaceView !== 'conversations' || selectedConversationId === undefined) return
    if (selectedConversationAnsweredTurn <= selectedConversationLastReadTurn) return
    setSelectedConversation((current) => current === null
      ? current
      : { ...current, last_read_turn: Math.max(current.last_read_turn ?? 0, selectedConversationAnsweredTurn) })
    void markConversationRead(selectedConversationId, selectedConversationAnsweredTurn)
      .then(() => setRailReadVersion((current) => current + 1))
      .catch(() => {})
  }, [workspaceView, selectedConversationId, selectedConversationAnsweredTurn, selectedConversationLastReadTurn])
  // Un tour qui se termine rend la conversation à lire pour tout le monde ;
  // celui qui l'a sous les yeux, fenêtre au premier plan, l'a justement lue.
  useEffect(() => {
    if (answeredCount === 0 || workspaceView !== 'conversations' || selectedConversationId === undefined) return
    if (!document.hasFocus()) return
    handleConversationRead()
  }, [answeredCount, workspaceView, selectedConversationId])

  useEffect(() => {
    function handleWindowFocus() {
      if (workspaceView !== 'conversations') return
      handleConversationRead()
    }
    window.addEventListener('focus', handleWindowFocus)
    return () => window.removeEventListener('focus', handleWindowFocus)
  }, [workspaceView, selectedConversationId, answeredCount])

  // Le rail agrège les non-lus de TOUS les projets : sans ce rafraîchissement,
  // un tour qui se termine ailleurs restait invisible jusqu'au prochain
  // rechargement de la liste du projet courant.
  const fleetMembership = fleet.items.map((item) => item.id).sort().join(',')
  useEffect(() => {
    setRailReadVersion((current) => current + 1)
  }, [fleetMembership])

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
      setConversationSeed(null)
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
    setConversationSeed(null)
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
    setConversationSeed(null)
    setNewConversationDraft('')
    setNewConversationAttachments([])
    setIsCreatingConversation(true)
    setShowSwitchModel(false)
    setWorkspaceView('conversations')
  }

  function handleStartFromTicket(seed: { ticketId: string; branch: string | null; ticketKey: string }) {
    if (!confirmLeaveMemory()) return
    if (selectedProject === null) return
    setConversationSeed(seed)
    setSelectedConversation(null)
    setNewConversationDraft('')
    setNewConversationAttachments([])
    setIsCreatingConversation(true)
    setShowSwitchModel(false)
    setWorkspaceView('conversations')
  }

  function handleStartFromContext(seed: { ticketId?: string | null; branch: string | null; ticketKey?: string | null; originType?: 'sentry' | null; originKey?: string | null }) {
    if (!confirmLeaveMemory() || selectedProject === null) return
    setConversationSeed(seed)
    setSelectedConversation(null)
    setNewConversationDraft('')
    setNewConversationAttachments([])
    setIsCreatingConversation(true)
    setShowSwitchModel(false)
    setWorkspaceView('conversations')
  }

  function handleConversationClosed() {
    setSelectedConversation(null)
    setConversationSeed(null)
    setIsCreatingConversation(false)
    setConversationListVersion((current) => current + 1)
  }

  /**
   * Le nombre de tours n'est pas déductible ici : la page d'événements chargée
   * peut ne couvrir que la fin du fil. Le sidecar cale donc lui-même la lecture
   * sur son dernier tour répondu, et c'est ce tour qui rend une conversation
   * à lire — d'où la clé de synchronisation.
   */
  function handleConversationRead() {
    if (selectedConversation === null) return
    const syncKey = `${selectedConversation.id}:${answeredCount}`
    if (readSyncKeyRef.current === syncKey) return
    readSyncKeyRef.current = syncKey
    void markConversationRead(selectedConversation.id)
      .then((updated) => {
        setSelectedConversation((current) => current === null || current.id !== updated.id
          ? current
          : {
              ...current,
              last_read_turn: updated.last_read_turn,
              answered_turn: updated.answered_turn,
              digest_turn: updated.digest_turn,
            })
        setRailReadVersion((current) => current + 1)
      })
      .catch(() => { readSyncKeyRef.current = null })
  }

  function handleConversationCreated(conversation: Conversation) {
    setSelectedConversation(conversation)
    setConversationSeed(null)
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
    setConversationSeed(null)
    setNewConversationDraft(`$${skill.invocation} `)
    setNewConversationAttachments([])
    setIsCreatingConversation(true)
    setWorkspaceView('conversations')
  }

  async function handlePaletteAction(action: 'test' | 'summary' | 'review') {
    if (!selectedConversation) return
    if (action === 'review') {
      await startReview({ conversationId: selectedConversation.id, scope: 'worktree' })
      return
    }
    setWorkspaceView('conversations')
    if (action === 'test') await createTestInventory(selectedConversation.id)
    else {
      const result = await createSessionSummary(selectedConversation.id)
      if (result.review) setChangelogReview(result.review)
    }
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
    setConversationSeed(null)
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

  const showSidebar = workspaceView === 'conversations'

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
        time={time.snapshot}
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
        onConversationCreateFromContext={handleStartFromContext}
        onConversationClosed={handleConversationClosed}
        isCreatingConversation={isCreatingConversation}
        onConversationRead={() => setRailReadVersion((current) => current + 1)}
        conversationListVersion={conversationListVersion}
        quotas={quotas}
        runningSubtasks={runningSubtasks}
        liveConversationMessageCount={liveConversationMessageCount}
        workspaceView={workspaceView}
        time={time.snapshot}
        timeMode={time.mode}
        onTimeModeToggle={time.toggleMode}
        agentRunning={fleet.items.length > 0}
        activeFleet={fleet.items}
        ticketLinks={ticketLinks}
        sentryLinks={sentryLinks}
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
        <Suspense fallback={<div className="empty-state"><p>Chargement…</p></div>}>
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
          <ProgressView snapshot={time.snapshot} />
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
            onStartConversation={handleStartFromTicket}
            onOpenSettings={() => setProjectSettingsOpen(true)}
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
                <h1>{selectedConversation?.title ?? 'Nouvelle conversation'}</h1>
                {selectedConversation !== null
                && branchOfWorktree(selectedConversation.worktree_path) !== null ? (
                  <span
                    className="conversation-branch"
                    title={`Worktree dédié : ${selectedConversation.worktree_path}`}
                  >
                    <BranchIcon />
                    {branchOfWorktree(selectedConversation.worktree_path)}
                  </span>
                ) : null}
                {selectedConversation?.ticket_instruction ? (
                  <ConversationInstruction instruction={selectedConversation.ticket_instruction} />
                ) : null}
                {(() => {
                  if (selectedConversation === null) return null
                  const links = (selectedConversation.ticket_key !== null && selectedConversation.ticket_key !== undefined
                    ? ticketLinks.get(selectedConversation.ticket_key)
                    : undefined)
                    ?? (selectedConversation.ticket_id !== null ? ticketLinks.get(selectedConversation.ticket_id) : undefined)
                  return links === undefined ? null : (
                    <TicketLinkIcons
                      links={links}
                      ticketKey={selectedConversation.ticket_key ?? links.ticketKey}
                    />
                  )
                })()}
                {(() => {
                  const originKey = selectedConversation?.origin_type === 'sentry'
                    ? selectedConversation.origin_key ?? null
                    : null
                  const url = originKey !== null ? sentryLinks.get(originKey) : undefined
                  return originKey !== null && url !== undefined
                    ? <SentryLinkIcon url={url} issueKey={originKey} />
                    : null
                })()}
              </div>
              {selectedConversation !== null ? (
                <div className="header-actions">
                  <ResumeCommandButton conversation={selectedConversation} />
                </div>
              ) : null}
            </header>
            <Chat
              key={selectedConversation === null
                ? `chat-new-${selectedProject.id}-${conversationSeed?.ticketId ?? ''}-${newConversationDraft}`
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
              initialConfig={conversationSeed
                ? { branch: conversationSeed.branch, ticketKey: conversationSeed.ticketKey }
                : undefined}
              ticketId={conversationSeed?.ticketId ?? null}
              originType={conversationSeed?.originType ?? null}
              originKey={conversationSeed?.originKey ?? null}
              reviewStatus={fleet.reviewStatus}
              onHandoff={() => setShowHandoff(true)}
              pendingChangelogReview={pendingChangelogReview}
              onChangelogReview={handleChangelogReview}
              onSwitchModel={() => setShowSwitchModel(true)}
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
        </Suspense>
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
      {changelogReview ? (
        <ChangelogReviewDialog
          review={changelogReview}
          onClose={() => setChangelogReview(null)}
          onPublished={() => setPendingChangelogReview(null)}
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
