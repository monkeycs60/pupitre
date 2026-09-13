import { WorkspaceInspector, inspectorGroupOf, type InspectorView } from './WorkspaceInspector'
import { TodoList } from './TodoList'
import { WorkflowsView } from './WorkflowsView'
import { linkTodo, useTodos, type TodoItem } from './todos'
import { ticketLinksOf } from './ticketLinks'
import { newConversationDraftStorageKey } from './conversationDraft'
import type { ConversationConfig } from './ConfigPanel'
import { QuotaBar } from './QuotaBar'
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react'
import { Chat, type ThreadTools } from './Chat'
import { Sidebar } from './Sidebar'
import { Rail } from './Rail'
import { Titlebar, type TitlebarDestination } from './Titlebar'
import { navigationShortcutLabel } from './navigationShortcuts'
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
import type { AppEvent, WorkspaceView } from './types'
import { useTimeTracking } from './useTimeTracking'
import { useFleet } from './useFleet'
import { countConversationMessages } from './conversationMessageCount'
import { ProjectSettingsDialog } from './ProjectSettingsDialog'
import { branchOfWorktree } from './conversationBranch'
import { BranchIcon } from './BranchIcon'
import { ConversationInstruction } from './ConversationInstruction'
import { ConversationDomains } from './ConversationDomains'
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
import { useInstance } from './useInstance'
import { useAttention } from './useAttention'
import { AttentionInbox } from './AttentionInbox'
import type { AttentionTarget } from './types'
import { retryUntilAvailable } from './startupRetry'
import { subscribeVisualFeedbackNavigation } from './visualFeedbackNavigation'
import { ProjectSectionSwitch } from './ProjectSectionSwitch'
import {
  PROJECT_SECTIONS,
  storeProjectLayout,
  storedProjectLayout,
  storedProjectSection,
  type ProjectSection,
  type ProjectSurfaceLayout,
} from './projectSections'

const SkillsLibrary = lazy(() => import('./SkillsLibrary').then((module) => ({ default: module.SkillsLibrary })))
const RoutinesView = lazy(() => import('./RoutinesView').then((module) => ({ default: module.RoutinesView })))
const FleetView = lazy(() => import('./FleetView').then((module) => ({ default: module.FleetView })))
const CostsView = lazy(() => import('./CostsView').then((module) => ({ default: module.CostsView })))
const MemoryView = lazy(() => import('./MemoryView').then((module) => ({ default: module.MemoryView })))
const HelpView = lazy(() => import('./HelpView').then((module) => ({ default: module.HelpView })))
const ProgressView = lazy(() => import('./ProgressView').then((module) => ({ default: module.ProgressView })))
const AppSettingsView = lazy(() => import('./AppSettingsView').then((module) => ({ default: module.AppSettingsView })))
const DesignView = lazy(() => import('./DesignView').then((module) => ({ default: module.DesignView })))
const DashboardView = lazy(() => import('./DashboardView').then((module) => ({ default: module.DashboardView })))

const DEFAULT_SIDEBAR_WIDTH = 296
const MIN_SIDEBAR_WIDTH = 200
/* La borne haute suit la fenêtre au lieu d'un palier fixe : sur un grand
   écran la liste peut occuper la moitié de la surface, la conversation
   gardant toujours de quoi s'afficher. */
const SIDEBAR_WIDTH_RATIO = 0.6
const SIDEBAR_WIDTH_STORAGE_KEY = 'pupitre.sidebar-width'

function maxSidebarWidth(viewport = window.innerWidth): number {
  return Math.max(MIN_SIDEBAR_WIDTH, Math.round(viewport * SIDEBAR_WIDTH_RATIO))
}

function clampSidebarWidth(width: number): number {
  return Math.min(maxSidebarWidth(), Math.max(MIN_SIDEBAR_WIDTH, width))
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
    /** Tâche ouverte « dans une conversation » : rattachée dès la création du fil. */
    todoId?: string
    config?: Partial<ConversationConfig>
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
  const [projectSurface, setProjectSurface] = useState<{
    section: ProjectSection
    layout: ProjectSurfaceLayout
  } | null>(null)
  const [todoPanelRequest, setTodoPanelRequest] = useState(0)
  const [todoMode, setTodoMode] = useState(false)
  const [editingTodo, setEditingTodo] = useState<TodoItem | null>(null)
  const lastInspectorViews = useRef<Partial<Record<string, InspectorView>>>({})
  const [focusEventId, setFocusEventId] = useState<number | null>(null)
  const todos = useTodos(selectedProject?.id ?? null)
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>('conversations')
  const [sidebarWidth, setSidebarWidth] = useState(storedSidebarWidth)
  const [threadTools, setThreadTools] = useState<ThreadTools | null>(null)
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

  useEffect(() => {
    function handleProjectSectionShortcut(event: KeyboardEvent) {
      if (event.defaultPrevented) return
      if (event.key === 'Escape' && projectSurface?.layout === 'full') {
        event.preventDefault()
        closeProjectSurface()
        return
      }
      if (!event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return
      const index = Number.parseInt(event.key, 10) - 1
      if (!Number.isInteger(index) || index < 0 || index > PROJECT_SECTIONS.length) return
      event.preventDefault()
      if (index === 0) closeProjectSurface()
      else openProjectSection(PROJECT_SECTIONS[index - 1]!.id)
    }
    window.addEventListener('keydown', handleProjectSectionShortcut)
    return () => window.removeEventListener('keydown', handleProjectSectionShortcut)
  }, [projectSurface, selectedProject?.id, inspector])
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
    function clampToViewport() {
      setSidebarWidth((current) => clampSidebarWidth(current))
    }
    window.addEventListener('resize', clampToViewport)
    return () => window.removeEventListener('resize', clampToViewport)
  }, [])

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
      setSidebarWidth(maxSidebarWidth())
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
    if (view === 'dashboard') {
      if (selectedProject !== null) openProjectSection(storedProjectSection(selectedProject.id))
      return
    }
    setProjectSurface(null)
    lastInspectorViews.current[inspectorGroupOf(view).title] = view
    setInspector(view)
    setWorkspaceView('conversations')
  }

  function closeInspector() {
    if (!confirmLeaveMemory()) return
    if (inspector === 'dashboard') setProjectSurface(null)
    setInspector(null)
  }

  function openProjectSection(section: ProjectSection, forcedLayout?: ProjectSurfaceLayout) {
    if (selectedProject === null) return
    const layout = forcedLayout ?? storedProjectLayout(selectedProject.id, section)
    if (forcedLayout !== undefined) storeProjectLayout(selectedProject.id, section, forcedLayout)
    window.localStorage.setItem(`pupitre:dashboard-tab:${selectedProject.id}`, section)
    setProjectSurface({ section, layout })
    setInspector(layout === 'docked' ? 'dashboard' : null)
    setWorkspaceView('conversations')
  }

  function closeProjectSurface() {
    setProjectSurface(null)
    if (inspector === 'dashboard') setInspector(null)
  }

  function toggleProjectLayout() {
    if (selectedProject === null || projectSurface === null) return
    const layout = projectSurface.layout === 'full' ? 'docked' : 'full'
    storeProjectLayout(selectedProject.id, projectSurface.section, layout)
    setProjectSurface({ ...projectSurface, layout })
    setInspector(layout === 'docked' ? 'dashboard' : null)
  }

  function handleTodoCreated() {
    setEditingTodo(null)
    setNewConversationDraft('')
    setNewConversationAttachments([])
    todos.refresh()
    openProjectSection('todos', 'docked')
    setTodoPanelRequest((value) => value + 1)
  }

  /** « Nouvelle tâche » : le composer d'une nouvelle conversation, en mode tâche. */
  function handleTodoCreate(seed?: { ticketId: string; ticketKey: string; branch: string | null }) {
    if (!confirmLeaveMemory() || selectedProject === null) return
    setSelectedConversation(null)
    setConversationSeed(seed ?? null)
    setEditingTodo(null)
    setNewConversationDraft('')
    setNewConversationAttachments([])
    setIsCreatingConversation(true)
    setShowSwitchModel(false)
    openProjectSection('todos', 'docked')
    setTodoPanelRequest((value) => value + 1)
    setTodoMode(true)
    setWorkspaceView('conversations')
  }

  /** Ouvre la conversation liée, ou une nouvelle conversation préremplie avec
   *  la tâche : message, pièces jointes, modèle, branche et ticket. */
  function handleTodoToConversation(item: TodoItem) {
    if (item.conversation_id) { void handleGitConversationSelect(item.conversation_id); return }
    loadTodoInComposer(item, false)
  }

  /** Recharge la tâche dans le composer en mode Tâche : l'envoi la remplace. */
  function handleTodoEdit(item: TodoItem) {
    loadTodoInComposer(item, true)
  }

  function loadTodoInComposer(item: TodoItem, edit: boolean) {
    if (!confirmLeaveMemory() || selectedProject === null) return
    // Le brouillon local du projet primerait sur le message de la tâche.
    try { localStorage.removeItem(newConversationDraftStorageKey(selectedProject.id, item.ticket_id)) } catch { /* stockage indisponible */ }
    setSelectedConversation(null)
    setEditingTodo(edit ? item : null)
    setConversationSeed({
      todoId: item.id,
      ticketId: item.ticket_id,
      ticketKey: ticketLinks.get(item.ticket_id ?? '')?.ticketKey ?? null,
      branch: item.target_branch || null,
      config: {
        presetId: item.preset_id ?? null,
        provider: item.provider,
        model: item.model,
        effort: item.effort ?? 'high',
        speed: item.speed ?? 'standard',
        permissionMode: item.permission_mode ?? null,
      },
    })
    setNewConversationDraft(item.message)
    setNewConversationAttachments(item.attachments)
    setIsCreatingConversation(true)
    setShowSwitchModel(false)
    setTodoMode(edit)
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
    setTodoPanelRequest(0)
    if (project.id !== selectedProject?.id) {
      setProjectSurface(null)
      if (inspector === 'dashboard') setInspector(null)
      setTodoMode(false)
      setEditingTodo(null)
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
    setFocusEventId(null)
    if (!confirmLeaveMemory()) return
    setSelectedConversation(conversation)
    setEditingTodo(null)
    setConversationSeed(null)
    setNewConversationDraft('')
    setNewConversationAttachments([])
    setIsCreatingConversation(false)
    setShowSwitchModel(false)
    closeProjectSurface()
    setWorkspaceView('conversations')
  }

  function handleConversationCreate() {
    if (!confirmLeaveMemory()) return
    if (selectedProject === null) return
    setSelectedConversation(null)
    setEditingTodo(null)
    setConversationSeed(null)
    setNewConversationDraft('')
    setNewConversationAttachments([])
    setIsCreatingConversation(true)
    setShowSwitchModel(false)
    closeProjectSurface()
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

  function handleStartFromContext(seed: { ticketId?: string | null; branch: string | null; ticketKey?: string | null; originType?: 'sentry' | 'problem' | null; originKey?: string | null }) {
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
    const todoId = conversationSeed?.todoId
    if (todoId) void linkTodo(todoId, conversation.id).then(todos.refresh, todos.refresh)
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

  function handleDashboardSelect() {
    if (!confirmLeaveMemory()) return
    if (selectedProject === null) return
    openProjectSection('todos')
    setShowSwitchModel(false)
  }

  function handleConversationsSelect() {
    if (!confirmLeaveMemory()) return
    setInspector(null)
    setProjectSurface(null)
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

  function handlePaletteViewSelect(view: 'fleet' | 'routines' | 'library' | 'memory' | 'help' | 'dashboard') {
    if (view === 'dashboard') handleDashboardSelect()
    else if (view === 'fleet') handleFleetSelect()
    else if (view === 'routines') handleRoutinesSelect()
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

  function renderProjectDashboard() {
    if (selectedProject === null || projectSurface === null) return null
    return <DashboardView
      embedded={projectSurface.layout === 'docked'}
      sectionOnly
      showSectionNavigation={false}
      key={`${selectedProject.id}-${projectSurface.layout}`}
      project={selectedProject}
      activeSection={projectSurface.section}
      onSectionChange={(section) => openProjectSection(section, projectSurface.layout)}
      todoCount={todos.items.filter((item) => item.status !== 'done').length}
      todoPanelRequest={todoPanelRequest}
      onRefreshTodos={todos.refresh}
      onCreateTodoFromTicket={(ticket) => handleTodoCreate({ ticketId: ticket.id, ticketKey: ticket.key, branch: ticketLinksOf(ticket).branch ?? null })}
      todoPanel={() => <div className="project-todos">
        <header className="project-tasks-header"><h2>Tâches du projet</h2><button type="button" className="primary-button" onClick={() => handleTodoCreate()}>+ Nouvelle tâche</button></header>
        <TodoList key={selectedProject.id} projectId={selectedProject.id} {...todos} selectedId={editingTodo?.id ?? conversationSeed?.todoId ?? null} ticketLinks={ticketLinks} onChanged={todos.refresh} onOpenConversation={handleTodoToConversation} onEdit={handleTodoEdit} />
      </div>}
      onConversationSelect={(conversationId) => void handleGitConversationSelect(conversationId)}
      onStartConversation={handleStartFromTicket}
      onOpenSettings={() => setProjectSettingsOpen(true)}
    />
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

  const railView: WorkspaceView = inspector === 'workflows'
    ? 'routines'
    : inspector === 'quotas' ? 'costs' : inspector ?? workspaceView

  const destinations: TitlebarDestination[] = [
    {
      name: 'conversations',
      label: 'Conversations',
      view: 'conversations',
      onClick: handleConversationsSelect,
      shortcut: navigationShortcutLabel('conversations'),
    },
    ...(window.__TAURI__
      ? [{
          name: 'design' as const,
          label: 'Claude Design',
          view: 'design' as const,
          onClick: handleDesignSelect,
          shortcut: navigationShortcutLabel('design'),
        }]
      : []),
    { name: 'attention', label: 'Activité', view: 'attention', onClick: handleAttentionSelect, badge: attention.items.length },
    { name: 'settings', label: 'Réglages', view: 'settings', onClick: handleSettingsSelect },
    { name: 'help', label: 'Aide', view: 'help', onClick: () => handleHelpSelect() },
  ]

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
        instance={instance}
        onRestart={restartApp}
        destinations={destinations}
        workspaceView={railView}
        hasProject={selectedProject !== null}
      />
      <Rail
        selectedProject={selectedProject}
        projectListVersion={projectListVersion}
        conversationListVersion={conversationListVersion + railReadVersion}
        onProjectSelect={handleProjectSelect}
        onProjectCreated={handleProjectSelect}
        workspaceView={railView}
        activeProjectIds={[...new Set(fleet.items.map((item) => item.projectId))]}
      />
      {showSidebar ? (
      <>
      <Sidebar
        selectedProject={selectedProject}
        selectedConversation={selectedConversation}
        quotas={quotas.snapshot}
        time={time.snapshot}
        timeMode={time.mode}
        onTimeModeToggle={time.toggleMode}
        agentRunning={fleet.items.length > 0}
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
        aria-valuemax={maxSidebarWidth()}
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
        <div className="workspace-split">
        <div className="conversation-workspace">
        <Suspense fallback={<div className="empty-state"><p>Chargement…</p></div>}>
        {workspaceView === 'design' ? <DesignView />
        : workspaceView === 'help' ? <HelpView key={helpSlug ?? 'index'} initialSlug={helpSlug} />
        : workspaceView === 'settings' ? <AppSettingsView instance={instance} />
        : selectedProject === null ? <div className="empty-state"><p>Sélectionne un projet pour commencer.</p></div>
        : projectSurface?.layout === 'full' ? (
          <>
            <header className="conversation-header project-surface-header">
              <div className="conversation-title-block">
                <button type="button" className="project-surface-back" onClick={closeProjectSurface} title="Revenir à la conversation (Échap)">
                  <span aria-hidden="true">←</span>
                  {selectedConversation?.title ?? 'Conversation'}
                </button>
                <h1>{PROJECT_SECTIONS.find((section) => section.id === projectSurface.section)?.label}</h1>
              </div>
              <div className="header-actions">
                <button type="button" className="project-layout-toggle" onClick={toggleProjectLayout} title="Ancrer cette section à droite" aria-label="Ancrer cette section à droite">⇥</button>
                <ProjectSectionSwitch
                  projectId={selectedProject.id}
                  activeSection={projectSurface.section}
                  todoCount={todos.items.filter((item) => item.status !== 'done').length}
                  onSelect={(section) => section === null ? closeProjectSurface() : openProjectSection(section)}
                />
              </div>
            </header>
            {renderProjectDashboard()}
          </>
        )
        : selectedConversation === null && !isCreatingConversation ? (
          <div className="empty-state">
            <div className="workspace-welcome"><h1>{selectedProject.name}</h1><p>Retrouve les tâches et le suivi dans le panneau projet.</p><div className="todo-detail-actions"><button className="primary-button" onClick={handleConversationCreate}>Nouvelle conversation</button><button className="secondary-button" onClick={() => openInspector('dashboard')}>Tâches du projet</button></div></div>
          </div>
        ) : (
          <>
            <header className="conversation-header">
              <div className="conversation-title-block">
                <h1>{selectedConversation?.title ?? 'Nouvelle conversation'}</h1>
                {selectedConversation ? (
                  <ConversationDomains
                    conversation={selectedConversation}
                    onChange={(updated) => {
                      setSelectedConversation(updated)
                      setConversationListVersion((current) => current + 1)
                    }}
                  />
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
              <div className="header-actions">
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
                {threadTools !== null && threadTools.assetCount > 0 ? (
                  <button
                    type="button"
                    className="header-action header-action-icon header-action-badged"
                    onClick={threadTools.openAssets}
                    title={`Afficher les pièces jointes (${threadTools.assetCount})`}
                    aria-label={`Afficher les ${threadTools.assetCount} pièce${threadTools.assetCount > 1 ? 's' : ''} jointe${threadTools.assetCount > 1 ? 's' : ''}`}
                  >
                    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path d="M2.5 4h4l1.25 1.4h5.75v7.1h-11V4Z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
                    </svg>
                    <span className="header-action-count">{threadTools.assetCount}</span>
                  </button>
                ) : null}
                {threadTools !== null ? (
                  <button
                    type="button"
                    className="header-action header-action-icon"
                    onClick={threadTools.openSearch}
                    title="Rechercher dans le fil (Ctrl F)"
                    aria-label="Rechercher dans le fil"
                  >
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                        <circle cx="7" cy="7" r="4.2" />
                        <path d="m10.2 10.2 3 3" />
                      </g>
                    </svg>
                  </button>
                ) : null}
                <ProjectSectionSwitch
                  projectId={selectedProject.id}
                  activeSection={projectSurface?.section ?? null}
                  todoCount={todos.items.filter((item) => item.status !== 'done').length}
                  onSelect={(section) => section === null ? closeProjectSurface() : openProjectSection(section)}
                />
              </div>
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
              todoMode={todoMode}
              onTodoModeChange={(mode) => { setTodoMode(mode); if (!mode) setEditingTodo(null) }}
              onTodoCreated={handleTodoCreated}
              editingTodoId={editingTodo?.id ?? null}
              initialFinish={editingTodo?.finish}
              onConversationRead={handleConversationRead}
              onRunningSubtasksChange={setRunningSubtasks}
              onThreadToolsChange={setThreadTools}
              initialMessage={newConversationDraft}
              initialAttachments={newConversationAttachments}
              initialConfig={conversationSeed
                ? { branch: conversationSeed.branch, ticketKey: conversationSeed.ticketKey, ...conversationSeed.config }
                : undefined}
              ticketId={conversationSeed?.ticketId ?? null}
              originType={conversationSeed?.originType ?? null}
              originKey={conversationSeed?.originKey ?? null}
              problemPlanIndex={conversationSeed?.problemPlanIndex ?? null}
              problemIds={conversationSeed?.problemIds}
              problemPlanIndices={conversationSeed?.problemPlanIndices}
              missionTitle={conversationSeed?.missionTitle}
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
        {workspaceView === 'conversations' && inspector ? <WorkspaceInspector
          view={inspector}
          onViewChange={openInspector}
          onClose={closeInspector}
          title={inspector === 'dashboard' && projectSurface ? PROJECT_SECTIONS.find((section) => section.id === projectSurface.section)?.label : undefined}
          headerAction={inspector === 'dashboard' && projectSurface ? <button type="button" className="project-layout-toggle" onClick={toggleProjectLayout} title="Afficher cette section en pleine largeur" aria-label="Afficher cette section en pleine largeur">⤢</button> : undefined}
        >
          <Suspense fallback={<p className="list-empty">Chargement…</p>}>
        {inspector === 'library' ? (
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
          renderProjectDashboard()
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
