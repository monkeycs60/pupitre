import { INSPECTOR_GROUPS, WorkspaceInspector, inspectorGroupOf, type InspectorView } from './WorkspaceInspector'
import { TodoEditor } from './TodoEditor'
import type { TodoDraftSeed } from './todoDraft'
import { WorkflowsView } from './WorkflowsView'
import { TodoDetail } from './TodoDetail'
import { useTodos, type TodoItem } from './todos'
import { QuotaBar } from './QuotaBar'
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
import type { Attachment, Conversation, Project } from './types'
import { useConversationEvents } from './useConversationEvents'
import { useQuotas } from './useQuotas'
import {
  getSettings,
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
import {
  locationForSelection,
  readLastActiveLocation,
  restoreConversation,
  restoreProject,
  writeLastActiveLocation,
} from './restoreLocation'
import { navigationViewForShortcut, type NavigationShortcutView } from './navigationShortcuts'
import { problemMissionDraft, type ProblemMissionSeed } from './problemMission'
import { useInstance } from './useInstance'
import { useAttention } from './useAttention'
import { AttentionInbox } from './AttentionInbox'
import type { AttentionTarget } from './types'
import { retryUntilAvailable } from './startupRetry'
import { subscribeVisualFeedbackNavigation } from './visualFeedbackNavigation'

const SkillsLibrary = lazy(() => import('./SkillsLibrary').then((module) => ({ default: module.SkillsLibrary })))
const RoutinesView = lazy(() => import('./RoutinesView').then((module) => ({ default: module.RoutinesView })))
const FleetView = lazy(() => import('./FleetView').then((module) => ({ default: module.FleetView })))
const CostsView = lazy(() => import('./CostsView').then((module) => ({ default: module.CostsView })))
const MemoryView = lazy(() => import('./MemoryView').then((module) => ({ default: module.MemoryView })))
const HelpView = lazy(() => import('./HelpView').then((module) => ({ default: module.HelpView })))
const ProgressView = lazy(() => import('./ProgressView').then((module) => ({ default: module.ProgressView })))
const AppSettingsView = lazy(() => import('./AppSettingsView').then((module) => ({ default: module.AppSettingsView })))
const SharedFilesView = lazy(() => import('./SharedFilesView').then((module) => ({ default: module.SharedFilesView })))
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
    let ignore = false
    const reportVisibility = () => {
      void setAppVisibility(document.visibilityState === 'visible').catch(() => {})
    }
    // La fenêtre peut être prête avant que le sidecar écoute : le premier
    // rapport est réessayé, sans quoi le rafraîchissement des intégrations
    // resterait éteint jusqu'au prochain changement de focus.
    void retryUntilAvailable(
      () => setAppVisibility(document.visibilityState === 'visible'),
      { cancelled: () => ignore },
    )
    document.addEventListener('visibilitychange', reportVisibility)
    return () => {
      ignore = true
      document.removeEventListener('visibilitychange', reportVisibility)
    }
  }, [])
  const [selectedProject, setSelectedProject] = useState<Project | null>(null)
  const [selectedConversation, setSelectedConversation] =
    useState<Conversation | null>(null)
  const [isCreatingConversation, setIsCreatingConversation] = useState(false)
  const [conversationSeed, setConversationSeed] = useState<{
    ticketId?: string | null
    ticketKey?: string | null
    branch: string | null
    originType?: 'sentry' | 'problem' | null
    originKey?: string | null
    problemPlanIndex?: number | null
    problemIds?: string[]
    problemPlanIndices?: Record<string, number[]>
    missionTitle?: string
  } | null>(null)
  const [newConversationDraft, setNewConversationDraft] = useState('')
  const [newConversationAttachments, setNewConversationAttachments] = useState<Attachment[]>([])
  const [conversationListVersion, setConversationListVersion] = useState(0)
  const [railReadVersion, setRailReadVersion] = useState(0)
  const readSyncKeyRef = useRef<string | null>(null)
  const navigationShortcutRef = useRef<(view: NavigationShortcutView) => void>(() => {})
  const [projectListVersion, setProjectListVersion] = useState(0)
  const [showSwitchModel, setShowSwitchModel] = useState(false)
  const [showHandoff, setShowHandoff] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [helpSlug, setHelpSlug] = useState<string | null>(null)
  const [memoryDirty, setMemoryDirty] = useState(false)
  const [inspector, setInspector] = useState<InspectorView | null>(null)
  const [selectedTodoId, setSelectedTodoId] = useState<string | null>(null)
  const [sidebarTab, setSidebarTab] = useState<'conversations' | 'todos'>('conversations')
  const [newTodo, setNewTodo] = useState(false)
  const [todoSeed, setTodoSeed] = useState<TodoDraftSeed | null>(null)
  const lastInspectorViews = useRef<Partial<Record<string, InspectorView>>>({})
  const [focusEventId, setFocusEventId] = useState<number | null>(null)
  const todos = useTodos(selectedProject?.id ?? null)
  const selectedTodo = todos.items.find((item) => item.id === selectedTodoId) ?? null
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
    inspector === 'progress' ? null : selectedProject?.id ?? null,
    inspector === 'progress' ? null : selectedConversation?.id ?? null,
  )
  const fleet = useFleet(selectedProject?.id)
  const attention = useAttention(selectedProject?.id)
  const instance = useInstance(fleet.connected)
  const ticketLinks = useTicketLinks(selectedProject?.id)
  const sentryLinks = useSentryLinks(selectedProject?.id)
  useAppNotifications()

  useEffect(() => subscribeVisualFeedbackNavigation((target) => {
    window.dispatchEvent(new CustomEvent('pupitre:open-conversation', { detail: target }))
  }), [])

  useEffect(() => {
    const openConversation = (event: Event) => {
      const conversationId = (event as CustomEvent<{ conversationId?: string }>).detail?.conversationId
      if (!conversationId) return
      void listProjects().then(async (projects) => {
        for (const project of projects) {
          const conversations = await listProjectConversations(project.id)
          if (conversations.some((conversation) => conversation.id === conversationId)) {
            await handleRoutineConversationSelect(project.id, conversationId)
            return
          }
        }
      })
    }
    window.addEventListener('pupitre:open-conversation', openConversation)
    return () => window.removeEventListener('pupitre:open-conversation', openConversation)
  })

  useEffect(() => {
    if (workspaceView === 'help' || !window.location.hash.startsWith('#help/')) return
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
  }, [workspaceView])

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

  useEffect(() => {
    function handleNavigationShortcut(event: KeyboardEvent) {
      const view = navigationViewForShortcut(event)
      if (view === null) return
      event.preventDefault()
      navigationShortcutRef.current(view)
    }
    window.addEventListener('keydown', handleNavigationShortcut)
    return () => window.removeEventListener('keydown', handleNavigationShortcut)
  }, [])
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

    void retryUntilAvailable(
      () => listProjects(),
      { cancelled: () => ignore },
    )
      .then(async (projects) => {
        if (ignore || projects === null) return
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

  function openInspector(view: InspectorView) {
    if (view !== inspector && !confirmLeaveMemory()) return
    lastInspectorViews.current[inspectorGroupOf(view).title] = view
    setInspector(view)
    setWorkspaceView('conversations')
  }

  function closeInspector() {
    if (confirmLeaveMemory()) setInspector(null)
  }

  function handleTodoCreated(todo: TodoItem) {
    todos.refresh()
    setSelectedTodoId(todo.id)
    setSidebarTab('todos')
    setNewTodo(false)
    setTodoSeed(null)
  }

  function handleDraftToTodo(seed: TodoDraftSeed) {
    setTodoSeed(seed)
    handleTodoCreate()
  }

  function handleTodoCreate() {
    if (!confirmLeaveMemory() || selectedProject === null) return
    setSelectedTodoId(null)
    setIsCreatingConversation(false)
    setShowSwitchModel(false)
    setNewTodo(true)
    setSidebarTab('todos')
    setWorkspaceView('conversations')
  }

  function confirmLeaveMemory(): boolean {
    if (inspector !== 'memory' || !memoryDirty) return true
    if (!window.confirm('Abandonner les modifications mémoire non enregistrées ?')) return false
    setMemoryDirty(false)
    return true
  }

  function handleProjectSelect(project: Project) {
    if (!confirmLeaveMemory()) return
    setSelectedTodoId(null)
    setSidebarTab('conversations')
    setNewTodo(false)
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
    setSelectedTodoId(null)
    setFocusEventId(null)
    setSidebarTab('conversations')
    setNewTodo(false)
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
    setSelectedTodoId(null)
    setNewTodo(false)
    setSidebarTab('conversations')
    if (!confirmLeaveMemory()) return
    if (selectedProject === null) return
    setSelectedConversation(null)
    setConversationSeed(null)
    setNewConversationDraft('')
    setNewConversationAttachments([])
    setSelectedTodoId(null)
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
    setSelectedTodoId(null)
    setIsCreatingConversation(true)
    setShowSwitchModel(false)
    setWorkspaceView('conversations')
  }

  function handleStartFromContext(seed: { ticketId?: string | null; branch: string | null; ticketKey?: string | null; originType?: 'sentry' | 'problem' | null; originKey?: string | null }) {
    if (!confirmLeaveMemory() || selectedProject === null) return
    setConversationSeed(seed)
    setSelectedConversation(null)
    setNewConversationDraft('')
    setNewConversationAttachments([])
    setSelectedTodoId(null)
    setIsCreatingConversation(true)
    setShowSwitchModel(false)
    setWorkspaceView('conversations')
  }

  function handleStartProblem(seed: ProblemMissionSeed) {
    if (!confirmLeaveMemory() || selectedProject === null) return
    const first = seed.problems[0]
    if (!first) return
    const commonTicketId = first.ticket_id !== null
      && seed.problems.every((problem) => problem.ticket_id === first.ticket_id)
      ? first.ticket_id
      : null
    const commonBranch = first.ticket_branch
      && seed.problems.every((problem) => problem.ticket_branch === first.ticket_branch)
      ? first.ticket_branch
      : null
    setConversationSeed({
      ticketId: commonTicketId,
      ticketKey: commonTicketId ? first.ticket_key ?? null : null,
      branch: commonBranch,
      problemIds: seed.problems.map((problem) => problem.id),
      problemPlanIndices: seed.planIndices,
      missionTitle: seed.missionTitle,
    })
    setSelectedConversation(null)
    setNewConversationDraft(problemMissionDraft(seed))
    setNewConversationAttachments([])
    setSelectedTodoId(null)
    setIsCreatingConversation(true)
    setShowSwitchModel(false)
    setWorkspaceView('conversations')
  }

  function handleSeeAllProblems() {
    if (selectedProject === null) return
    window.localStorage.setItem(`pupitre:dashboard-tab:${selectedProject.id}`, 'problems')
    openInspector('dashboard')
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
    openInspector('costs')
    setShowSwitchModel(false)
  }

  function handleDashboardSelect() {
    if (!confirmLeaveMemory()) return
    if (selectedProject === null) return
    openInspector('dashboard')
    setShowSwitchModel(false)
  }

  function handleDocumentsSelect() {
    if (!confirmLeaveMemory()) return
    openInspector('documents')
    setShowSwitchModel(false)
  }

  function handleConversationsSelect() {
    if (!confirmLeaveMemory()) return
    setInspector(null)
    setWorkspaceView('conversations')
    setShowSwitchModel(false)
  }

  function handleLibrarySelect() {
    if (!confirmLeaveMemory()) return
    openInspector('library')
    setShowSwitchModel(false)
  }

  function handleRoutinesSelect() {
    if (!confirmLeaveMemory()) return
    openInspector('workflows')
    setShowSwitchModel(false)
  }

  function handleFleetSelect() {
    if (!confirmLeaveMemory()) return
    openInspector('fleet')
    setShowSwitchModel(false)
  }

  function handleAttentionSelect() {
    if (!confirmLeaveMemory()) return
    openInspector('attention')
    setShowSwitchModel(false)
  }

  function handleAttentionOpen(target: AttentionTarget) {
    if (target.kind === 'conversation') {
      void handleRoutineConversationSelect(target.projectId, target.conversationId)
      return
    }
    const project = selectedProject?.id === target.projectId
      ? selectedProject
      : null
    if (project) {
      window.localStorage.setItem(`pupitre:dashboard-tab:${project.id}`, 'problems')
      openInspector('dashboard')
    }
  }

  function handleDesignSelect() {
    if (!confirmLeaveMemory()) return
    setWorkspaceView('design')
    setShowSwitchModel(false)
  }

  navigationShortcutRef.current = (view) => {
    if (view === 'conversations') handleConversationsSelect()
    else if (view === 'fleet') handleFleetSelect()
    else if (view === 'dashboard') handleDashboardSelect()
    else if (view === 'documents') handleDocumentsSelect()
    else handleDesignSelect()
  }

  function handleMemorySelect() {
    openInspector('memory')
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
    setSelectedTodoId(null)
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
      await createSessionSummary(selectedConversation.id)
    }
  }

  async function handleRoutineConversationSelect(projectId: string, conversationId: string, eventId?: number) {
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
    setFocusEventId(eventId ?? null)
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
        documents: 'Fichiers',
        design: 'Claude Design',
        dashboard: 'Projet',
        costs: 'Utilisation',
        library: 'Skills',
        routines: 'Automatisations',
        fleet: 'Exécutions',
        attention: 'À traiter',
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
        instance={instance}
        onRestart={restartApp}
      />
      <Rail
        selectedProject={selectedProject}
        projectListVersion={projectListVersion}
        conversationListVersion={conversationListVersion + railReadVersion}
        onProjectSelect={handleProjectSelect}
        onProjectCreated={handleProjectSelect}
        workspaceView={inspector === 'workflows' ? 'routines' : inspector === 'quotas' ? 'costs' : inspector ?? workspaceView}
        onConversationsSelect={handleConversationsSelect}
        onDashboardSelect={handleDashboardSelect}
        onDesignSelect={handleDesignSelect}
        onCostsSelect={handleCostsSelect}
        onLibrarySelect={handleLibrarySelect}
        onRoutinesSelect={handleRoutinesSelect}
        onAttentionSelect={handleAttentionSelect}
        onHelpSelect={() => handleHelpSelect()}
        onSettingsSelect={handleSettingsSelect}
        attentionCount={attention.items.length}
        activeProjectIds={[...new Set(fleet.items.map((item) => item.projectId))]}
      />
      {showSidebar ? (
      <>
      <Sidebar
        selectedProject={selectedProject}
        selectedConversation={selectedTodoId || newTodo ? null : selectedConversation}
        sidebarTab={sidebarTab}
        onSidebarTabChange={setSidebarTab}
        todos={todos}
        selectedTodoId={selectedTodoId}
        onTodoSelect={(id) => { setSelectedTodoId(id); setIsCreatingConversation(false); setWorkspaceView('conversations') }}
        onTodoCreate={() => { setTodoSeed(null); handleTodoCreate() }}
        onUsageSelect={() => openInspector('quotas')}
        onProjectSelect={handleProjectSelect}
        onConversationSelect={handleConversationSelect}
        onConversationCreate={handleConversationCreate}
        onConversationCreateFromContext={handleStartFromContext}
        onConversationClosed={handleConversationClosed}
        isCreatingConversation={isCreatingConversation}
        onConversationRead={() => setRailReadVersion((current) => current + 1)}
        conversationListVersion={conversationListVersion}
        runningSubtasks={runningSubtasks}
        liveConversationMessageCount={liveConversationMessageCount}
        workspaceView={workspaceView}
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
        {workspaceView === 'conversations' ? <nav className="workspace-toolbar" aria-label="Outils du projet">
          <span>{selectedProject?.name ?? 'Conversations'}</span>
          <div>{INSPECTOR_GROUPS.map((group) => {
            const active = inspector !== null && group.tabs.some(([id]) => id === inspector)
            const count = group.title === 'Activité' ? attention.items.length : 0
            return <button key={group.title} type="button" aria-pressed={active} disabled={group.needsProject && !selectedProject} onClick={() => active ? closeInspector() : openInspector(lastInspectorViews.current[group.title] ?? group.tabs[0][0])}>{group.title}{count > 0 ? <span className="workspace-toolbar-count">{count}</span> : null}</button>
          })}</div>
        </nav> : null}
        <div className="workspace-split">
        <div className="conversation-workspace">
        <Suspense fallback={<div className="empty-state"><p>Chargement…</p></div>}>
        {workspaceView === 'design' ? <DesignView />
        : workspaceView === 'help' ? <HelpView key={helpSlug ?? 'index'} initialSlug={helpSlug} />
        : workspaceView === 'settings' ? <AppSettingsView instance={instance} />
        : selectedProject === null ? <div className="empty-state"><p>Sélectionne un projet pour commencer.</p></div>
        : newTodo ? <TodoEditor key={`${selectedProject.id}-${todoSeed ? 'seed' : 'blank'}`} project={selectedProject} items={todos.items} quotas={quotas.snapshot} initial={todoSeed} onProjectUpdated={handleProjectUpdated} onCreated={handleTodoCreated} onCancel={() => { setNewTodo(false); setTodoSeed(null) }} />
        : selectedTodo ? <TodoDetail key={selectedTodo.id} item={selectedTodo} items={todos.items} projectName={selectedProject.name} onChanged={todos.refresh} onDeleted={() => { setSelectedTodoId(null); todos.refresh() }} onConversationSelect={(id) => void handleGitConversationSelect(id)} />
        : selectedConversation === null && !isCreatingConversation ? (
          <div className="empty-state">
            <div className="workspace-welcome"><h1>{selectedProject.name}</h1><p>Une conversation pour avancer, une TODO pour préparer la suite.</p><button className="primary-button" onClick={handleConversationCreate}>Nouvelle conversation</button></div>
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
              focusEventId={focusEventId}
              onDraftToTodo={handleDraftToTodo}
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
              problemPlanIndex={conversationSeed?.problemPlanIndex ?? null}
              problemIds={conversationSeed?.problemIds}
              problemPlanIndices={conversationSeed?.problemPlanIndices}
              missionTitle={conversationSeed?.missionTitle}
              onStartProblem={handleStartProblem}
              onSeeAllProblems={handleSeeAllProblems}
              reviewStatus={fleet.reviewStatus}
              onHandoff={() => setShowHandoff(true)}
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
        </div>
        {workspaceView === 'conversations' && inspector ? <WorkspaceInspector view={inspector} onViewChange={openInspector} onClose={closeInspector}>
          <Suspense fallback={<p className="list-empty">Chargement…</p>}>
        {inspector === 'documents' ? (
          <SharedFilesView
            currentProject={selectedProject}
            conversationId={selectedConversation?.id ?? null}
            onConversationSelect={(projectId, conversationId, eventId) => void handleRoutineConversationSelect(projectId, conversationId, eventId)}
          />
        ) : inspector === 'library' ? (
          <SkillsLibrary project={selectedProject} />
        ) : inspector === 'routines' ? (
          <RoutinesView
            key={selectedProject?.id}
            initialProject={selectedProject}
            onConversationSelect={(projectId, conversationId) => void handleRoutineConversationSelect(projectId, conversationId)}
          />
        ) : inspector === 'fleet' ? (
          <FleetView
            projectId={selectedProject?.id}
            onConversationSelect={(projectId, conversationId) => void handleRoutineConversationSelect(projectId, conversationId)}
          />
        ) : inspector === 'attention' ? (
          <AttentionInbox
            items={attention.items}
            loading={attention.loading}
            error={attention.error}
            projectName={selectedProject?.name}
            onOpen={handleAttentionOpen}
            onAcknowledge={attention.acknowledge}
          />
        ) : inspector === 'memory' ? (
          <MemoryView onDirtyChange={setMemoryDirty} />
        ) : inspector === 'progress' ? (
          <ProgressView snapshot={time.snapshot} />
        ) : selectedProject === null ? (
          <div className="empty-state">
            <p>Sélectionnez un projet pour commencer.</p>
          </div>
        ) : inspector === 'dashboard' ? (
          <DashboardView
            embedded
            key={selectedProject.id}
            project={selectedProject}
            onConversationSelect={(conversationId) => void handleGitConversationSelect(conversationId)}
            onStartConversation={handleStartFromTicket}
            onStartProblem={handleStartProblem}
            onOpenSettings={() => setProjectSettingsOpen(true)}
          />
        ) : inspector === 'costs' ? (
          <CostsView
            project={selectedProject}
            onConversationSelect={(conversationId) => void handleGitConversationSelect(conversationId)}
          />
        ) : inspector === 'workflows' && selectedProject ? (
          <WorkflowsView key={selectedProject.id} project={selectedProject} onConversationSelect={handleConversationSelect} />
        ) : inspector === 'quotas' ? <QuotaBar snapshot={quotas.snapshot} /> : null}
          </Suspense>
        </WorkspaceInspector> : null}
        </div>
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
        instance={instance}
        onPromotionSelect={handleSettingsSelect}
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
