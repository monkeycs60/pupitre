import { memo, useEffect, useMemo, useRef, useState } from 'react'
import {
  associateConversationDomain,
  dissociateConversationDomain,
  listProjectConversations,
  listProjectDomains,
  listProjectWorkflows,
  markConversationRead,
  renameConversation,
  runWorkflow,
  setConversationArchived,
  purgeTrashedConversations,
  setConversationDeleted,
  setConversationPinned,
  setConversationPermissionMode,
} from './api'
import { QuotaStatus } from './QuotaBar'
import type { Conversation, FleetItem, Project, ProjectDomain, TimeMode, TimeSnapshot, Workflow, WorkspaceView } from './types'
import type { Quotas } from './useQuotas'
import { WorkflowDialog } from './WorkflowDialog'
import { ProjectSettingsDialog } from './ProjectSettingsDialog'
import { modelLabel } from './modelOptions'
import { ProviderMark } from './ProviderMark'
import { filterWorkflows, workflowSummary } from './workflowSidebar'
import { useNow } from './useNow'
import { LevelCard } from './LevelCard'
import { branchOfWorktree } from './conversationBranch'
import { BranchIcon } from './BranchIcon'
import { SentryLinkIcon, TicketLinkIcons } from './TicketLinkIcons'
import type { TicketLinks } from './ticketLinks'

declare global {
  interface Window {
    __TAURI__?: Record<string, unknown>
  }
}

interface SidebarProps {
  selectedProject: Project | null
  selectedConversation: Conversation | null
  onProjectSelect: (project: Project) => void
  onConversationSelect: (conversation: Conversation) => void
  onConversationCreate: () => void
  onConversationCreateFromContext?: (seed: { ticketId?: string | null; branch: string | null; ticketKey?: string | null; originType?: 'sentry' | null; originKey?: string | null }) => void
  onConversationClosed?: () => void
  onConversationRead?: () => void
  conversationListVersion: number
  quotas: Quotas
  /** Sous-tâches en cours dans la conversation ouverte (cf. App). */
  runningSubtasks: number
  /** Compteur recalculé depuis le replay/flux live de la conversation ouverte. */
  liveConversationMessageCount?: number
  /** Snapshot Fleet global, nécessaire pour marquer les conversations non ouvertes comme live. */
  activeFleet?: FleetItem[]
  workspaceView: WorkspaceView
  time: TimeSnapshot | null
  timeMode: TimeMode
  onTimeModeToggle: () => void
  /** Un tour tourne : la carte le signale sans changer de compteur. */
  agentRunning?: boolean
  /** Liens ClickUp / MR par clé de ticket, pour les groupes contextuels. */
  ticketLinks?: Map<string, TicketLinks>
  /** Permalinks Sentry par shortId d'issue, pour les groupes scout. */
  sentryLinks?: Map<string, string>
}

function pinnedFirst<T extends { pinned: boolean }>(items: T[]): T[] {
  return [...items].sort((left, right) => Number(right.pinned) - Number(left.pinned))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Une erreur est survenue.'
}

function conversationRelation(
  conversation: Conversation,
  conversations: Conversation[],
): string | null {
  if (conversation.continued_from) {
    const source = conversations.find((item) => item.id === conversation.continued_from)
    return `↳ suite de ${source?.title ?? 'la conversation précédente'}`
  }
  const continuation = conversations.find(
    (item) => item.continued_from === conversation.id,
  )
  return continuation ? `→ passation vers ${continuation.title}` : null
}

type ConversationScope = 'active' | 'archived' | 'trash'
type SidebarTab = 'conversations' | 'workflows'

const CONVERSATION_SCOPES: Array<[ConversationScope, string]> = [
  ['active', 'Actives'],
  ['archived', 'Archives'],
  ['trash', 'Corbeille'],
]

const SCOPE_PLACEHOLDERS: Record<ConversationScope, string> = {
  active: 'Filtrer les conversations actives…',
  archived: 'Filtrer les archives…',
  trash: 'Filtrer la corbeille…',
}
const conversationListCache = new Map<string, Conversation[]>()
type ConversationRowState = 'live' | 'unread' | 'read'

function conversationRowState(
  conversation: Conversation,
  activeConversationIds: Set<string>,
): ConversationRowState {
  if (activeConversationIds.has(conversation.id)) return 'live'
  return conversation.digest_turn > (conversation.last_read_turn ?? 0) ? 'unread' : 'read'
}

function conversationMessageCount(conversation: Conversation, liveCount?: number): number {
  return Math.max(0, liveCount ?? conversation.message_count ?? conversation.digest_turn)
}

function elapsedConversationTime(startedAt: string | undefined, now: number): string {
  if (!startedAt) return '0 min 00'
  const elapsedSeconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1_000))
  return `${Math.floor(elapsedSeconds / 60)} min ${String(elapsedSeconds % 60).padStart(2, '0')}`
}

function relativeConversationTime(value: string): string {
  const elapsed = Math.max(0, Date.now() - Date.parse(value))
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return 'à l’instant'
  if (minutes < 60) return `il y a ${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `il y a ${hours} h`
  const days = Math.floor(hours / 24)
  return days < 7 ? `il y a ${days} j` : new Date(value).toLocaleDateString('fr-FR')
}

/** Horodatage compact aligné à droite de chaque conversation (now / 4 min /
 *  2 h / lun / 08/06), comme dans la maquette. */
function shortConversationTime(value: string): string {
  const elapsed = Math.max(0, Date.now() - Date.parse(value))
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h`
  const days = Math.floor(hours / 24)
  if (days < 7) {
    return new Date(value).toLocaleDateString('fr-FR', { weekday: 'short' }).replace('.', '')
  }
  return new Date(value).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })
}

type ConversationGroup = {
  key: string
  label: string
  items: Conversation[]
  latestUpdatedAt?: number
  /** Clé du ticket pour les groupes contextuels : porte les liens externes. */
  ticketKey?: string | null
  /** ShortId de l'issue pour les groupes Sentry : porte le permalink. */
  sentryKey?: string | null
}

/** Regroupe les conversations par récence (épinglées d'abord), comme la
 *  maquette : Épinglées / Aujourd'hui / Cette semaine / Plus ancien. */
function groupConversationsByRecency(items: Conversation[]): ConversationGroup[] {
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  const todayMs = startOfToday.getTime()
  const weekMs = 7 * 86_400_000
  const groups: ConversationGroup[] = [
    { key: 'pinned', label: 'Épinglées', items: [] },
    { key: 'today', label: "Aujourd'hui", items: [] },
    { key: 'week', label: 'Cette semaine', items: [] },
    { key: 'older', label: 'Plus ancien', items: [] },
  ]
  for (const conversation of items) {
    if (conversation.pinned) {
      groups[0]!.items.push(conversation)
      continue
    }
    const updated = Date.parse(conversation.updated_at)
    if (updated >= todayMs) groups[1]!.items.push(conversation)
    else if (Date.now() - updated < weekMs) groups[2]!.items.push(conversation)
    else groups[3]!.items.push(conversation)
  }
  return groups.filter((group) => group.items.length > 0)
}

function groupConversations(items: Conversation[]): ConversationGroup[] {
  const conversationsByTicket = new Map<string, Conversation[]>()
  const conversationsBySentryIssue = new Map<string, Conversation[]>()
  const withoutTicket: Conversation[] = []
  for (const conversation of items) {
    if (conversation.origin_type === 'sentry' && conversation.origin_key) {
      const grouped = conversationsBySentryIssue.get(conversation.origin_key) ?? []
      grouped.push(conversation)
      conversationsBySentryIssue.set(conversation.origin_key, grouped)
      continue
    }
    if (conversation.ticket_key) {
      const grouped = conversationsByTicket.get(conversation.ticket_key) ?? []
      grouped.push(conversation)
      conversationsByTicket.set(conversation.ticket_key, grouped)
      continue
    }
    withoutTicket.push(conversation)
  }
  const contextualGroups = [
    ...[...conversationsByTicket.entries()].map(([key, grouped]) => ({ type: 'ticket', key, grouped })),
    ...[...conversationsBySentryIssue.entries()].map(([key, grouped]) => ({ type: 'sentry', key, grouped })),
  ]
    .map((context) => ({
      key: `${context.type}-${context.key}`,
      label: context.type === 'sentry' ? `Sentry · ${context.key}` : context.key,
      ticketKey: context.type === 'ticket' ? context.key : null,
      sentryKey: context.type === 'sentry' ? context.key : null,
      items: context.grouped,
      latestUpdatedAt: Math.max(...context.grouped.map((conversation) => Date.parse(conversation.updated_at))),
    }))
  const recencyGroups = groupConversationsByRecency(withoutTicket).map((group) => ({
    ...group,
    latestUpdatedAt: Math.max(...group.items.map((conversation) => Date.parse(conversation.updated_at))),
  }))
  return [...contextualGroups, ...recencyGroups]
    .sort((left, right) => left.key === 'pinned' ? -1 : right.key === 'pinned' ? 1 : (right.latestUpdatedAt ?? 0) - (left.latestUpdatedAt ?? 0))
}

export const Sidebar = memo(function Sidebar({
  selectedProject,
  selectedConversation,
  onProjectSelect,
  onConversationSelect,
  onConversationCreate,
  onConversationCreateFromContext,
  onConversationClosed,
  onConversationRead,
  conversationListVersion,
  quotas,
  runningSubtasks,
  liveConversationMessageCount,
  activeFleet = [],
  workspaceView,
  time,
  timeMode,
  onTimeModeToggle,
  agentRunning = false,
  ticketLinks,
  sentryLinks,
}: SidebarProps) {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isRunningWorkflow, setIsRunningWorkflow] = useState<string | null>(null)
  const [showWorkflowDialog, setShowWorkflowDialog] = useState(false)
  const [workflowToEdit, setWorkflowToEdit] = useState<Workflow | null>(null)
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('conversations')
  const [conversationScope, setConversationScope] = useState<ConversationScope>('active')
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [filterText, setFilterText] = useState('')
  const [workflowFilterText, setWorkflowFilterText] = useState('')
  const [openConversationMenu, setOpenConversationMenu] = useState<string | null>(null)
  const [renameConversationId, setRenameConversationId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [projectSettingsProject, setProjectSettingsProject] = useState<Project | null>(null)
  const [domainRevision, setDomainRevision] = useState(0)
  const [projectDomains, setProjectDomains] = useState<ProjectDomain[]>([])
  const [domainMenuOpen, setDomainMenuOpen] = useState(false)
  const selectedConversationRef = useRef(selectedConversation)
  selectedConversationRef.current = selectedConversation
  const workspaceViewRef = useRef(workspaceView)
  workspaceViewRef.current = workspaceView
  const onConversationReadRef = useRef(onConversationRead)
  onConversationReadRef.current = onConversationRead
  // La seconde n'alimente que le chrono des conversations live ; au repos, ce
  // tick re-rendait toute la sidebar (groupes, tris, previews) chaque seconde.
  const now = useNow(activeFleet.length > 0 || runningSubtasks > 0 ? 1_000 : 30_000)
  const activeByConversation = useMemo(() => {
    const byConversation = new Map<string, FleetItem>()
    for (const item of activeFleet) {
      if (!byConversation.has(item.conversationId)) byConversation.set(item.conversationId, item)
    }
    return byConversation
  }, [activeFleet])
  const activeConversationIds = useMemo(() => new Set(activeByConversation.keys()), [activeByConversation])
  const activeDomains = useMemo(() => projectDomains.filter((domain) => domain.status === 'actif'), [projectDomains])
  const proposedDomainCount = useMemo(() => projectDomains.filter((domain) => domain.status === 'proposé').length, [projectDomains])
  const displayedActiveConversationIds = useMemo(() => {
    const ids = new Set(activeConversationIds)
    if (workspaceView === 'conversations' && selectedConversation !== null && runningSubtasks > 0) ids.add(selectedConversation.id)
    return ids
  }, [activeConversationIds, workspaceView, selectedConversation, runningSubtasks])
  useEffect(() => {
    let ignore = false
    if (selectedProject === null) return

    const listKey = `${selectedProject.id}:${conversationScope}`
    const cached = conversationListCache.get(listKey)
    if (cached) setConversations(cached)
    void listProjectConversations(selectedProject.id, conversationScope)
      .then((items) => {
        if (!ignore) {
          const scopedItems = items
          const currentSelectedConversation = selectedConversationRef.current
          const selectedLoadedConversation = workspaceViewRef.current === 'conversations' && currentSelectedConversation !== null
            ? scopedItems.find((item) => item.id === currentSelectedConversation.id)
            : undefined
          const shouldMarkSelectedRead = selectedLoadedConversation !== undefined
            && selectedLoadedConversation.digest_turn > (selectedLoadedConversation.last_read_turn ?? 0)
          const nextItems = shouldMarkSelectedRead
            ? scopedItems.map((item) => item.id === selectedLoadedConversation.id
              ? { ...item, last_read_turn: selectedLoadedConversation.digest_turn }
              : item)
            : scopedItems
          const ordered = pinnedFirst(nextItems)
          conversationListCache.set(listKey, ordered)
          setConversations(ordered)
          if (shouldMarkSelectedRead) {
            void markConversationRead(
              selectedLoadedConversation.id,
              selectedLoadedConversation.digest_turn,
            ).then(() => onConversationReadRef.current?.()).catch(() => {})
          }
        }
      })
      .catch((loadError: unknown) => {
        if (!ignore) setError(errorMessage(loadError))
      })
    void listProjectWorkflows(selectedProject.id)
      .then((items) => { if (!ignore) setWorkflows(items) })
      .catch(() => {})
    void listProjectDomains(selectedProject.id)
      .then((items) => { if (!ignore) setProjectDomains(items) })
      .catch(() => { if (!ignore) setProjectDomains([]) })

    return () => {
      ignore = true
    }
  }, [selectedProject, conversationListVersion, conversationScope, domainRevision])

  useEffect(() => {
    setSidebarTab('conversations')
    setFilterText('')
    setWorkflowFilterText('')
    setWorkflowToEdit(null)
    setShowWorkflowDialog(false)
    setScopeMenuOpen(false)
    try {
      const stored = localStorage.getItem(`pupitre:sidebar-collapsed:${selectedProject?.id ?? ''}`)
      setCollapsedGroups(new Set(stored === null ? [] : JSON.parse(stored) as string[]))
    } catch {
      setCollapsedGroups(new Set())
    }
  }, [selectedProject?.id])

  function toggleGroupCollapsed(groupKey: string) {
    setCollapsedGroups((current) => {
      const next = new Set(current)
      if (next.has(groupKey)) next.delete(groupKey)
      else next.add(groupKey)
      try {
        localStorage.setItem(`pupitre:sidebar-collapsed:${selectedProject?.id ?? ''}`, JSON.stringify([...next]))
      } catch {
        // La préférence reste en mémoire si le stockage local est bloqué.
      }
      return next
    })
  }

  function handleProjectSettings(project: Project) {
    setProjectSettingsProject(project)
  }

  function handleProjectSettingsUpdated(updated: Project) {
    if (selectedProject?.id === updated.id) onProjectSelect(updated)
  }

  function handleConversationSelect(conversation: Conversation) {
    const lastReadTurn = Math.max(conversation.last_read_turn ?? 0, conversation.digest_turn)
    const updated = { ...conversation, last_read_turn: lastReadTurn }
    setConversations((current) => current.map((item) => item.id === conversation.id ? updated : item))
    onConversationSelect(updated)
    void markConversationRead(conversation.id, lastReadTurn)
      .then(() => onConversationRead?.())
      .catch(() => {})
  }

  async function handleConversationPin(conversation: Conversation) {
    setError(null)
    try {
      await setConversationPinned(conversation.id, !conversation.pinned)
      const updated = { ...conversation, pinned: !conversation.pinned }
      setConversations((current) =>
        pinnedFirst(
          current.map((item) => (item.id === conversation.id ? updated : item)),
        ),
      )
      if (selectedConversation?.id === conversation.id) {
        onConversationSelect(updated)
      }
    } catch (pinError: unknown) {
      setError(errorMessage(pinError))
    }
  }

  async function handleConversationYolo(conversation: Conversation) {
    const enabling = conversation.permission_mode !== 'bypassPermissions'
    if (enabling && !window.confirm(
      `Activer YOLO pour « ${conversation.title} » ?\n\nClaude ignorera les demandes de permission pour les tours suivants.`,
    )) return
    setError(null)
    try {
      const updated = await setConversationPermissionMode(
        conversation.id,
        enabling ? 'bypassPermissions' : null,
      )
      setConversations((current) => current.map((item) => item.id === updated.id ? updated : item))
      if (selectedConversation?.id === updated.id) onConversationSelect(updated)
    } catch (permissionError: unknown) {
      setError(errorMessage(permissionError))
    }
  }

  function closeConversationMenu() {
    setOpenConversationMenu(null)
    setDomainMenuOpen(false)
    setRenameConversationId(null)
    setRenameDraft('')
  }

  function applyConversationDomains(conversation: Conversation, domains: Conversation['domains']) {
    const updated = { ...conversation, domains: domains ?? [] }
    setConversations((current) => current.map((item) => item.id === conversation.id ? updated : item))
    if (selectedConversation?.id === conversation.id) onConversationSelect(updated)
  }

  async function handleDomainToggle(conversation: Conversation, domain: ProjectDomain) {
    const attached = (conversation.domains ?? []).some((item) => item.id === domain.id)
    setError(null)
    try {
      const updated = attached
        ? await dissociateConversationDomain(conversation.id, domain.id)
        : await associateConversationDomain(conversation.id, domain.id)
      applyConversationDomains(conversation, updated.domains)
    } catch (domainError: unknown) {
      setError(errorMessage(domainError))
    }
  }

  function startRename(conversation: Conversation) {
    setOpenConversationMenu(null)
    setRenameConversationId(conversation.id)
    setRenameDraft(conversation.title)
  }

  async function handleRenameSubmit(conversation: Conversation) {
    const title = renameDraft.trim()
    if (!title) return
    setError(null)
    try {
      const updated = await renameConversation(conversation.id, title)
      setConversations((current) => current.map((item) => item.id === updated.id ? updated : item))
      if (selectedConversation?.id === updated.id) onConversationSelect(updated)
      closeConversationMenu()
    } catch (renameError: unknown) {
      setError(errorMessage(renameError))
    }
  }

  async function handleArchiveToggle(conversation: Conversation) {
    setError(null)
    try {
      const updated = await setConversationArchived(conversation.id, !conversation.archived)
      setConversations((current) => conversationScope === 'active' && updated.archived
        ? current.filter((item) => item.id !== updated.id)
        : conversationScope === 'archived' && !updated.archived
          ? current.filter((item) => item.id !== updated.id)
          : current.map((item) => item.id === updated.id ? updated : item))
      if (updated.archived && selectedConversation?.id === updated.id) onConversationClosed?.()
      closeConversationMenu()
    } catch (archiveError: unknown) {
      setError(errorMessage(archiveError))
    }
  }

  async function handleTrashPurge() {
    // Suppression définitive : la conversation, ses événements et ses
    // sous-tâches disparaissent. La confirmation le dit franchement.
    if (!window.confirm(
      `Supprimer définitivement ${conversations.length} conversation(s) ?\n\nLeurs messages et sous-tâches partent avec. C'est irréversible.`,
    )) return
    setError(null)
    try {
      await purgeTrashedConversations()
      setConversations([])
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'La corbeille n’a pas pu être vidée.')
    }
  }

  async function handleTrashToggle(conversation: Conversation) {
    setError(null)
    try {
      const updated = await setConversationDeleted(conversation.id, conversationScope !== 'trash')
      if (conversationScope === 'trash' || updated.deleted_at !== null) {
        setConversations((current) => current.filter((item) => item.id !== updated.id))
      } else {
        setConversations((current) => current.map((item) => item.id === updated.id ? updated : item))
      }
      if (updated.deleted_at !== null && selectedConversation?.id === updated.id) onConversationClosed?.()
      closeConversationMenu()
    } catch (trashError: unknown) {
      setError(errorMessage(trashError))
    }
  }

  function openWorkflowDialog(workflow: Workflow | null = null) {
    setWorkflowToEdit(workflow)
    setShowWorkflowDialog(true)
  }

  async function handleWorkflowRun(workflow: Workflow) {
    if (isRunningWorkflow !== null) return
    setError(null)
    setIsRunningWorkflow(workflow.id)
    try {
      const conversation = await runWorkflow(workflow.id)
      setSidebarTab('conversations')
      onConversationSelect(conversation)
    } catch (runError: unknown) {
      setError(errorMessage(runError))
    } finally {
      setIsRunningWorkflow(null)
    }
  }


  const conversationGroups = useMemo(() => {
    const query = filterText.trim().toLowerCase()
    const filtered = query
      ? conversations.filter((item) => item.title.toLowerCase().includes(query))
      : conversations
    return groupConversations(filtered)
  }, [conversations, filterText])

  return (
    <aside className="sidebar">
      <div className="conv-sidebar-header">
        <div className="conv-sidebar-project">
          <div className="conv-sidebar-name">
            {selectedProject ? selectedProject.name : 'Aucun projet'}
          </div>
          <div className="conv-sidebar-path" title={selectedProject?.path}>
            {selectedProject ? selectedProject.path : 'Choisis un projet dans le rail'}
          </div>
        </div>
        {selectedProject ? (
          <button
            type="button"
            className="conv-sidebar-gear"
            onClick={() => handleProjectSettings(selectedProject)}
            aria-label={`Paramètres de ${selectedProject.name}${proposedDomainCount > 0 ? `, ${proposedDomainCount} domaine${proposedDomainCount > 1 ? 's' : ''} proposé${proposedDomainCount > 1 ? 's' : ''}` : ''}`}
            title={proposedDomainCount > 0 ? `${proposedDomainCount} domaine${proposedDomainCount > 1 ? 's' : ''} proposé${proposedDomainCount > 1 ? 's' : ''}` : 'Paramètres du projet'}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <g stroke="currentColor" strokeWidth="1.25">
                <circle cx="8" cy="8" r="2" />
                <path d="M6.5 2h3l.5 2a4.5 4.5 0 0 1 1.3.8l1.9-.7 1.5 2.6-1.5 1.3a5 5 0 0 1 0 1.6l1.5 1.3-1.5 2.6-1.9-.7a4.5 4.5 0 0 1-1.3.8l-.5 2h-3l-.5-2a4.5 4.5 0 0 1-1.3-.8l-1.9.7-1.5-2.6 1.5-1.3a5 5 0 0 1 0-1.6L1.3 6.7l1.5-2.6 1.9.7A4.5 4.5 0 0 1 6 4l.5-2Z" />
              </g>
            </svg>
            {proposedDomainCount > 0 ? <span className="conv-sidebar-gear-badge" aria-hidden="true">{proposedDomainCount}</span> : null}
          </button>
        ) : null}
      </div>

      <section className="sidebar-section conversations" aria-label="Navigation du projet">
        <div className="sidebar-tabs" role="tablist" aria-label="Contenu de la sidebar">
          <button
            id="sidebar-conversations-tab"
            type="button"
            role="tab"
            aria-selected={sidebarTab === 'conversations'}
            aria-controls="sidebar-conversations-panel"
            className={sidebarTab === 'conversations' ? 'is-selected' : ''}
            onClick={() => setSidebarTab('conversations')}
          >
            Conversations <span>{conversations.length}</span>
          </button>
          <button
            id="sidebar-workflows-tab"
            type="button"
            role="tab"
            aria-selected={sidebarTab === 'workflows'}
            aria-controls="sidebar-workflows-panel"
            className={sidebarTab === 'workflows' ? 'is-selected' : ''}
            onClick={() => setSidebarTab('workflows')}
          >
            Workflows <span>{workflows.length}</span>
          </button>
        </div>

        {sidebarTab === 'conversations' ? (
          <div id="sidebar-conversations-panel" role="tabpanel" aria-labelledby="sidebar-conversations-tab">
        {/* Deux libellés entiers ne tiennent pas à côté du titre dans la largeur
            de la sidebar : ils se tronquaient. Ils ont leur propre rangée. */}
        <div className="section-actions">
          <button
            type="button"
            className="section-action section-action--primary"
            onClick={onConversationCreate}
            disabled={selectedProject === null}
            title="Démarrer une nouvelle conversation dans ce projet"
          >
            <span aria-hidden="true">+</span>
            <span>Nouvelle conversation</span>
          </button>
        </div>

        <div className={`conversation-filter-input${conversationScope !== 'active' ? ' has-scope' : ''}`}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
              <circle cx="7" cy="7" r="4.2" />
              <path d="m10.2 10.2 3 3" />
            </g>
          </svg>
          <input
            type="text"
            value={filterText}
            onChange={(event) => setFilterText(event.target.value)}
            placeholder={SCOPE_PLACEHOLDERS[conversationScope]}
            aria-label="Filtrer les conversations"
          />
          <button
            type="button"
            className="conversation-scope-toggle"
            aria-label="Choisir le périmètre : actives, archives ou corbeille"
            aria-haspopup="menu"
            aria-expanded={scopeMenuOpen}
            title="Actives, archives ou corbeille"
            onClick={() => setScopeMenuOpen((open) => !open)}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M2.5 4h11M4.5 8h7M6.5 12h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {scopeMenuOpen ? (
          <div className="conversation-scope-anchor">
          <div className="conversation-scope-menu" role="menu" aria-label="Périmètre des conversations">
            {CONVERSATION_SCOPES.map(([scope, label]) => (
              <button
                type="button"
                key={scope}
                role="menuitemradio"
                aria-checked={conversationScope === scope}
                className={conversationScope === scope ? 'is-selected' : ''}
                onClick={() => {
                  closeConversationMenu()
                  setConversationScope(scope)
                  setScopeMenuOpen(false)
                }}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  {conversationScope === scope ? (
                    <path d="M2.5 8.5 6 12l7.5-8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  ) : null}
                </svg>
                {label}
              </button>
            ))}
          </div>
          </div>
        ) : null}

        {conversationScope === 'trash' && conversations.length > 0 ? (
          <button type="button" className="trash-purge-button" onClick={() => void handleTrashPurge()}>
            Vider la corbeille ({conversations.length})
          </button>
        ) : null}

        <div className="navigation-list">
          {selectedProject === null ? (
            <p className="list-empty">Sélectionnez un projet</p>
          ) : conversations.length === 0 ? (
            <p className="list-empty">Aucune conversation</p>
          ) : (() => {
            if (conversationGroups.length === 0) {
              return <p className="list-empty">Aucune conversation ne correspond</p>
            }
            return conversationGroups.map((group) => {
              const isCollapsed = collapsedGroups.has(group.key)
              const unread = group.items.filter((conversation) => (
                conversationRowState(conversation, displayedActiveConversationIds) === 'unread'
              )).length
              const groupLinks = group.ticketKey ? ticketLinks?.get(group.ticketKey) : undefined
              const groupSentryUrl = group.sentryKey ? sentryLinks?.get(group.sentryKey) : undefined
              return (
              <div className="conv-group" key={group.key}>
                <div className="conv-group-header">
                  <button
                    type="button"
                    className="conv-group-toggle"
                    aria-expanded={!isCollapsed}
                    aria-label={`${isCollapsed ? 'Déplier' : 'Replier'} ${group.label}`}
                    onClick={() => toggleGroupCollapsed(group.key)}
                  >
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true" style={isCollapsed ? { transform: 'rotate(-90deg)' } : undefined}>
                      <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <span>{group.label}</span>
                  </button>
                  {groupLinks ? <TicketLinkIcons links={groupLinks} ticketKey={group.ticketKey!} /> : null}
                  {groupSentryUrl !== undefined ? <SentryLinkIcon url={groupSentryUrl} issueKey={group.sentryKey!} /> : null}
                  <span className="conv-group-rule" aria-hidden="true" />
                  {(group.key.startsWith('ticket-') || group.key.startsWith('sentry-')) && onConversationCreateFromContext ? (
                    <button
                      type="button"
                      className="conv-group-create"
                      aria-label={`Nouvelle conversation dans ${group.label}`}
                      onClick={() => {
                        const context = group.items[0]!
                        onConversationCreateFromContext({
                          ticketId: context.ticket_id,
                          ticketKey: context.ticket_key,
                          branch: context.origin_type === 'sentry' ? null : groupLinks?.branch ?? null,
                          originType: context.origin_type,
                          originKey: context.origin_key,
                        })
                      }}
                    >+</button>
                  ) : null}
                  {unread > 0 ? (
                    <span className="conv-group-count is-attention">{unread} à lire</span>
                  ) : null}
                  <span className="conv-group-count">{group.items.length}</span>
                </div>
                {isCollapsed ? null : group.items.map((conversation) => {
                const isSelected = (workspaceView === 'conversations' || workspaceView === 'git')
                  && selectedConversation?.id === conversation.id
                const activeItem = activeByConversation.get(conversation.id)
                const state = conversationRowState(conversation, displayedActiveConversationIds)
                const branch = branchOfWorktree(conversation.worktree_path)
                const messageCount = isSelected ? liveConversationMessageCount : undefined
                return (
              <div
                className={`navigation-row conv-row-state-${state}${conversation.origin_type === 'sentry' ? ' conv-row-sentry' : ''} ${isSelected ? 'is-selected' : ''}`}
                key={conversation.id}
              >
                <span className={`conv-row-edge ${state === 'unread' ? 'is-visible' : ''}`} aria-hidden="true" />
                <span className={`conv-row-land ${state === 'unread' ? 'is-visible' : ''}`} aria-hidden="true" />
                <button
                  type="button"
                  className="navigation-main"
                  onClick={() => handleConversationSelect(conversation)}
                  aria-describedby={`conversation-preview-${conversation.id}`}
                >
                  <span className="conv-row-line1">
                    <span className={`conv-row-dot is-${state}`} aria-hidden="true" />
                    <span className="conv-row-title">{conversation.title}</span>
                    <span className="conv-row-time">
                      {state === 'live'
                        ? elapsedConversationTime(activeItem?.startedAt, now)
                        : shortConversationTime(conversation.updated_at)}
                    </span>
                  </span>
                  {state === 'live' ? (
                    <span className="conv-row-activity">
                      <span className="conv-row-dots" aria-hidden="true"><i /><i /><i /></span>
                      <span className="conv-row-activity-label">écrit la réponse</span>
                      <span className="conv-row-count">{conversationMessageCount(conversation, messageCount)}</span>
                    </span>
                  ) : (
                    <span className="conv-row-line2">
                      {conversation.origin_type === 'sentry' ? (
                        <ProviderMark provider="sentry" className="conv-row-mark" />
                      ) : <ProviderMark provider={conversation.provider} className="conv-row-mark" />}
                      {conversation.ticket_key ? (
                        <span className="conv-row-ticket">{conversation.ticket_key}</span>
                      ) : null}
                      {branch !== null ? (
                        <span className="conv-row-branch" title={`Branche du worktree : ${conversation.worktree_path}`}>
                          <BranchIcon />{branch}
                        </span>
                      ) : conversation.created_on_branch !== null ? (
                        <span className="conv-row-branch" title={`Branche à la création`}>
                          <BranchIcon />{conversation.created_on_branch}
                        </span>
                      ) : null}
                    </span>
                  )}
                  {conversationRelation(conversation, conversations) ? (
                    <span className="conversation-link">
                      {conversationRelation(conversation, conversations)}
                    </span>
                  ) : null}
                </button>
                <div className="conversation-row-actions">
                  <button
                    type="button"
                    className={`pin-button ${conversation.pinned ? 'is-pinned' : ''}`}
                    onClick={() => void handleConversationPin(conversation)}
                    aria-label={conversation.pinned ? `Désépingler ${conversation.title}` : `Épingler ${conversation.title}`}
                    aria-pressed={conversation.pinned}
                    title={conversation.pinned ? 'Désépingler' : 'Épingler'}
                  >
                    <span aria-hidden="true">{conversation.pinned ? '◆' : '◇'}</span>
                  </button>
                  <button
                    type="button"
                    className="conversation-more-button"
                    aria-label={`Actions pour ${conversation.title}`}
                    aria-expanded={openConversationMenu === conversation.id}
                    onClick={() => {
                      setDomainMenuOpen(false)
                      setOpenConversationMenu((current) => current === conversation.id ? null : conversation.id)
                    }}
                  >
                    <span aria-hidden="true">⋯</span>
                  </button>
                  {openConversationMenu === conversation.id ? (
                    <div className="conversation-actions-menu" role="menu">
                      <button type="button" role="menuitem" onClick={() => startRename(conversation)}>Renommer</button>
                      {projectDomains.length > 0 ? (
                        <div className="conversation-domain-item">
                          <button
                            type="button"
                            role="menuitem"
                            aria-haspopup="true"
                            aria-expanded={domainMenuOpen}
                            onClick={() => setDomainMenuOpen((open) => !open)}
                          >
                            Domaines
                          </button>
                          {domainMenuOpen ? (
                            <div className="conversation-domains-submenu" role="group" aria-label="Domaines de la conversation">
                              {activeDomains.length === 0 ? (
                                <p className="conversation-domains-empty">Aucun domaine validé</p>
                              ) : activeDomains.map((domain) => {
                                const attached = (conversation.domains ?? []).some((item) => item.id === domain.id)
                                return (
                                  <button
                                    key={domain.id}
                                    type="button"
                                    role="menuitemcheckbox"
                                    aria-checked={attached}
                                    onClick={() => void handleDomainToggle(conversation, domain)}
                                  >
                                    {domain.name}
                                  </button>
                                )
                              })}
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                      <button type="button" role="menuitem" onClick={() => void handleConversationYolo(conversation)}>
                        {conversation.permission_mode === 'bypassPermissions'
                          ? 'Désactiver YOLO'
                          : 'Activer YOLO'}
                      </button>
                      <button type="button" role="menuitem" onClick={() => void handleArchiveToggle(conversation)}>
                        {conversation.archived ? 'Désarchiver' : 'Archiver'}
                      </button>
                      {conversationScope === 'trash' ? (
                        <button type="button" role="menuitem" onClick={() => void handleTrashToggle(conversation)}>Restaurer</button>
                      ) : (
                        <button type="button" role="menuitem" className="is-danger" onClick={() => void handleTrashToggle(conversation)}>Mettre à la corbeille</button>
                      )}
                    </div>
                  ) : null}
                </div>
                {renameConversationId === conversation.id ? (
                  <form className="conversation-rename-form" onSubmit={(event) => { event.preventDefault(); void handleRenameSubmit(conversation) }}>
                    <input
                      value={renameDraft}
                      onChange={(event) => setRenameDraft(event.target.value)}
                      aria-label={`Nouveau titre pour ${conversation.title}`}
                      autoFocus
                      onKeyDown={(event) => { if (event.key === 'Escape') closeConversationMenu() }}
                    />
                    <button type="submit">OK</button>
                  </form>
                ) : null}
                <div
                  className="conversation-hover-preview"
                  role="tooltip"
                  id={`conversation-preview-${conversation.id}`}
                >
                  <strong>{conversation.title}</strong>
                  <p>{conversation.summary || conversation.title}</p>
                  <span>{conversation.provider} · {modelLabel(conversation.model)} · {relativeConversationTime(conversation.updated_at)}</span>
                  <span className="conversation-hover-preview-config">
                    effort: {conversation.effort ?? 'default'}
                    {conversation.speed === 'fast' ? ' · vitesse: 1.5x' : ''}
                  </span>
                </div>
              </div>
                )
                })}
              </div>
              )
            })
          })()}
        </div>
          </div>
        ) : (
          <div id="sidebar-workflows-panel" className="workflow-sidebar-panel" role="tabpanel" aria-labelledby="sidebar-workflows-tab">
            <div className="section-actions">
              <button
                type="button"
                className="section-action section-action--primary"
                onClick={() => openWorkflowDialog()}
                disabled={selectedProject === null}
                title="Créer un workflow réutilisable pour ce projet"
              >
                <span aria-hidden="true">+</span>
                <span>Nouveau workflow</span>
              </button>
            </div>

            <div className="conversation-filter-input">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                  <circle cx="7" cy="7" r="4.2" />
                  <path d="m10.2 10.2 3 3" />
                </g>
              </svg>
              <input
                type="text"
                value={workflowFilterText}
                onChange={(event) => setWorkflowFilterText(event.target.value)}
                placeholder={`Filtrer ${workflows.length} workflow${workflows.length > 1 ? 's' : ''}…`}
                aria-label="Filtrer les workflows"
              />
            </div>

            {selectedProject === null ? (
              <p className="list-empty">Sélectionnez un projet</p>
            ) : workflows.length === 0 ? (
              <p className="list-empty">Aucun workflow. Créez un raccourci pour vos tâches répétitives.</p>
            ) : (() => {
              const filtered = filterWorkflows(workflows, workflowFilterText)
              return filtered.length === 0 ? (
                <p className="list-empty">Aucun workflow ne correspond</p>
              ) : (
                <div className="workflow-sidebar-list">
                  {filtered.map((workflow) => (
                    <article className="workflow-sidebar-row" key={workflow.id}>
                      <div className="workflow-sidebar-copy">
                        <strong>{workflow.name}</strong>
                        <p title={workflowSummary(workflow)}>{workflowSummary(workflow)}</p>
                        <span><code>${workflow.skill_invocation}</code> · {workflow.preset_id ? 'preset' : modelLabel(workflow.model)}</span>
                      </div>
                      <div className="workflow-sidebar-actions">
                        <button type="button" onClick={() => void handleWorkflowRun(workflow)} disabled={isRunningWorkflow !== null}>
                          {isRunningWorkflow === workflow.id ? 'Lancement…' : 'Lancer →'}
                        </button>
                        <button type="button" onClick={() => openWorkflowDialog(workflow)} aria-label={`Modifier ${workflow.name}`} title="Modifier ce workflow">✎</button>
                      </div>
                    </article>
                  ))}
                </div>
              )
            })()}
          </div>
        )}
      </section>

      {error && (
        <p className="sidebar-error" role="alert">
          {error}
        </p>
      )}

      {showWorkflowDialog && selectedProject ? (
        <WorkflowDialog
          key={selectedProject.id}
          project={selectedProject}
          workflows={workflows}
          initialWorkflow={workflowToEdit}
          onClose={() => {
            setShowWorkflowDialog(false)
            setWorkflowToEdit(null)
          }}
          onChanged={setWorkflows}
        />
      ) : null}

      {projectSettingsProject ? (
        <ProjectSettingsDialog
          key={projectSettingsProject.id}
          project={projectSettingsProject}
          onClose={() => setProjectSettingsProject(null)}
          onUpdated={handleProjectSettingsUpdated}
          onDomainsChanged={() => setDomainRevision((current) => current + 1)}
        />
      ) : null}

      <div className="sidebar-footer">
        {time ? (
          <LevelCard
            snapshot={time}
            mode={timeMode}
            agentRunning={agentRunning}
            onToggle={onTimeModeToggle}
          />
        ) : null}
        <div className="sidebar-quotas">
          <QuotaStatus snapshot={quotas.snapshot} />
        </div>
      </div>
    </aside>
  )
})
