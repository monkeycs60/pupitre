import { ProjectLaunch, ProjectLiveLaunches } from './ProjectLaunch'
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  listProjectConversations,
  searchConversationsWithAi,
  markConversationRead,
  renameConversation,
  setConversationArchived,
  purgeTrashedConversations,
  setConversationDeleted,
  setConversationPinned,
  setConversationPermissionMode,
} from './api'
import type { Conversation, ConversationNudge, FleetItem, Project, Provider, QuotaSnapshot, WorkspaceView } from './types'
import { QuotaStatus } from './QuotaBar'
import { ConversationAiResults, type AiSearchState } from './ConversationAiResults'
import { ProjectSettingsDialog } from './ProjectSettingsDialog'
import { ProviderMark } from './ProviderMark'
import { shortenHomePath } from './projectInitials'
import { ProjectAvatar } from './ProjectAvatar'
import { useNow } from './useNow'
import { branchOfWorktree } from './conversationBranch'
import { Icon } from './Icon'
import { applicationsForConversation, PortChip } from './PortChip'
import { ProjectSectionSwitch } from './ProjectSectionSwitch'
import type { ProjectSection } from './projectSections'
import { useRunningApplications } from './runningApplicationsStore'
import { pushToast } from './toasts'
import { toolPresentation } from './toolPresentation'
import { SentryLinkIcon, TicketLinkIcons } from './TicketLinkIcons'
import type { TicketLinks } from './ticketLinks'

declare global {
  interface Window {
    __TAURI__?: Record<string, unknown>
  }
}

interface SidebarProps {
  quotas?: QuotaSnapshot
  quotaProviders?: Provider[]
  /** Questions et choix que des agents attendent ; leurs conversations passent dans « À toi ». */
  nudges?: ConversationNudge[]
  activeSection?: ProjectSection | null
  onSectionSelect?: (section: ProjectSection | null) => void
  todoCount?: number
  selectedProject: Project | null
  selectedConversation: Conversation | null
  onProjectSelect: (project: Project) => void
  onConversationSelect: (conversation: Conversation) => void
  onConversationCreate: () => void
  onConversationCreateFromContext?: (seed: { ticketId?: string | null; branch: string | null; ticketKey?: string | null; originType?: 'sentry' | 'problem' | null; originKey?: string | null }) => void
  onConversationClosed?: () => void
  onConversationRead?: () => void
  /** Composer ouvert pour une conversation qui n'existe pas encore : rien ne
   *  doit alors être restauré à sa place. */
  isCreatingConversation?: boolean
  conversationListVersion: number
  /** Sous-tâches en cours dans la conversation ouverte (cf. App). */
  runningSubtasks: number
  /** Snapshot Fleet global, nécessaire pour marquer les conversations non ouvertes comme live. */
  activeFleet?: FleetItem[]
  workspaceView: WorkspaceView
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
type ConversationSortMode = 'context' | 'recent'

const CONVERSATION_SCOPES: Array<[ConversationScope, string]> = [
  ['active', 'Actives'],
  ['archived', 'Archives'],
  ['trash', 'Corbeille'],
]

const SCOPE_PLACEHOLDERS: Record<ConversationScope, string> = {
  active: 'Filtrer les conversations…',
  archived: 'Filtrer les archives…',
  trash: 'Filtrer la corbeille…',
}
const conversationListCache = new Map<string, Conversation[]>()
const LAST_CONVERSATION_KEY = 'pupitre:last-conversation:'
const CONVERSATION_SORT_KEY = 'pupitre:conversation-sort'

function readConversationSortMode(): ConversationSortMode {
  try {
    return localStorage.getItem(CONVERSATION_SORT_KEY) === 'recent' ? 'recent' : 'context'
  } catch {
    return 'context'
  }
}

function readLastConversationId(projectId: string): string | null {
  try {
    return localStorage.getItem(`${LAST_CONVERSATION_KEY}${projectId}`)
  } catch {
    return null
  }
}

type ConversationRowState = 'live' | 'unread' | 'read'

function conversationRowState(
  conversation: Conversation,
  activeConversationIds: Set<string>,
): ConversationRowState {
  if (activeConversationIds.has(conversation.id)) return 'live'
  return (conversation.answered_turn ?? 0) > (conversation.last_read_turn ?? 0) ? 'unread' : 'read'
}

function elapsedConversationTime(startedAt: string | undefined, now: number): string {
  if (!startedAt) return '0 min 00'
  const elapsedSeconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1_000))
  return `${Math.floor(elapsedSeconds / 60)} min ${String(elapsedSeconds % 60).padStart(2, '0')}`
}

/** « TECH-25064 » → « 25064 » : à côté du titre du ticket, le préfixe du projet n'apprend rien. */
export function shortTicketKey(label: string): string {
  return /^[A-Z][A-Z0-9]*-\d+$/.test(label) ? label.slice(label.indexOf('-') + 1) : label
}

export function ticketTitleWithoutKey(title: string, ticketKey: string): string {
  return title
    .replace(new RegExp(`^${ticketKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(?:[-–—:·]\\s*)?`, 'i'), '')
    .trim()
}

/** Horodatage compact aligné à droite de chaque conversation (now / 4 min /
 *  2 h / lun / 08/06), comme dans la maquette. */
const WEEKDAY_FORMAT = new Intl.DateTimeFormat('fr-FR', { weekday: 'short' })
const DAY_MONTH_FORMAT = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit' })

function shortConversationTime(value: string): string {
  const elapsed = Math.max(0, Date.now() - Date.parse(value))
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h`
  const days = Math.floor(hours / 24)
  if (days < 7) {
    return WEEKDAY_FORMAT.format(new Date(value)).replace('.', '')
  }
  return DAY_MONTH_FORMAT.format(new Date(value))
}

type ConversationGroupKind = 'waiting' | 'live' | 'pinned' | 'context' | 'plain'

type ConversationGroup = {
  kind?: ConversationGroupKind
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


const TRUNK_BRANCHES = ['main', 'master', 'develop', 'dev', 'staging', 'preprod', 'production']

function isTrunkBranch(branch: string, detectedTrunk: string | null | undefined): boolean {
  const name = branch.replace(/^(?:refs\/heads\/|refs\/remotes\/[^/]+\/|origin\/)/, '')
  return TRUNK_BRANCHES.includes(name) || name === detectedTrunk
}

/** Branche de travail affichée sous une conversation ; le tronc n'en est pas une. */
export function workBranchLabel(conversation: Conversation, worktreeBranch: string | null, detectedTrunk?: string | null): { label: string; title: string } | null {
  if (worktreeBranch !== null) {
    if (isTrunkBranch(worktreeBranch, detectedTrunk)) return null
    const paths = conversation.worktree_paths?.length ? conversation.worktree_paths : [conversation.worktree_path]
    return {
      label: `${worktreeBranch}${paths.length > 1 ? ` +${paths.length - 1}` : ''}`,
      title: `Worktrees : ${paths.join(', ')}`,
    }
  }
  if (conversation.created_on_branch === null || isTrunkBranch(conversation.created_on_branch, detectedTrunk)) return null
  return { label: conversation.created_on_branch, title: 'Branche à la création' }
}

const COMPACT_GROUP_LIMIT = 2
const COMPACT_GROUP_WINDOW_MS = 24 * 3_600_000

/** Conversations montrées par un groupe de ticket replié : les trois plus
 *  récentes de moins de 24 h, au moins la plus récente, plus celles qu'on ne
 *  doit jamais masquer (sélectionnée, en cours, non lue). L'ordre du groupe
 *  est gardé. */
export function compactGroupItems(items: Conversation[], alwaysVisible: Set<string>, now = Date.now()): Conversation[] {
  const byRecency = [...items].sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at))
  const recent = byRecency
    .filter((conversation) => now - Date.parse(conversation.updated_at) < COMPACT_GROUP_WINDOW_MS)
    .slice(0, COMPACT_GROUP_LIMIT)
  const visible = new Set((recent.length > 0 ? recent : byRecency.slice(0, 1)).map((conversation) => conversation.id))
  return items.filter((conversation) => visible.has(conversation.id) || alwaysVisible.has(conversation.id))
}

const PLAIN_GROUP_LIMIT = 8
const PLAIN_GROUP_WINDOW_MS = 7 * 86_400_000
export const TIDY_AFTER_MS = 7 * 86_400_000

/** « Sans ticket » montre la semaine en cours, huit au plus, plus les lignes à ne jamais masquer. */
export function compactPlainItems(items: Conversation[], alwaysVisible: Set<string>, now = Date.now()): Conversation[] {
  const recent = new Set(items
    .filter((conversation) => now - Date.parse(conversation.updated_at) < PLAIN_GROUP_WINDOW_MS)
    .slice(0, PLAIN_GROUP_LIMIT)
    .map((conversation) => conversation.id))
  if (recent.size === 0 && items[0]) recent.add(items[0].id)
  return items.filter((conversation) => recent.has(conversation.id) || alwaysVisible.has(conversation.id))
}

/** Statut d'abord : ce qui attend l'utilisateur, ce qui tourne, puis le reste par ticket.
 *  Les deux tables donnent le début de l'attente ou du tour, en millisecondes. */
export function groupConversationsByStatus(
  items: Conversation[],
  waitingSince: Map<string, number>,
  liveSince: Map<string, number>,
): ConversationGroup[] {
  const waiting = items.filter((conversation) => !liveSince.has(conversation.id) && waitingSince.has(conversation.id))
    .sort((left, right) => waitingSince.get(left.id)! - waitingSince.get(right.id)!)
  const live = items.filter((conversation) => liveSince.has(conversation.id))
    .sort((left, right) => liveSince.get(left.id)! - liveSince.get(right.id)!)
  const rest = items.filter((conversation) => !liveSince.has(conversation.id) && !waitingSince.has(conversation.id))
  const groups: ConversationGroup[] = []
  if (waiting.length > 0) groups.push({ kind: 'waiting', key: 'waiting', label: 'À toi', items: waiting })
  if (live.length > 0) groups.push({ kind: 'live', key: 'live', label: 'En cours', items: live })
  const pinned = rest.filter((conversation) => conversation.pinned)
  if (pinned.length > 0) groups.push({ kind: 'pinned', key: 'pinned', label: 'Épinglées', items: pinned })
  const others = rest.filter((conversation) => !conversation.pinned)
  const contextual = groupConversations(others).filter((group) => group.ticketKey || group.sentryKey)
  const plain = others
    .filter((conversation) => !contextual.some((group) => group.items.includes(conversation)))
    .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at))
  groups.push(...contextual.map((group) => ({ ...group, kind: 'context' as const })))
  if (plain.length > 0) groups.push({ kind: 'plain', key: 'plain', label: 'Sans ticket', items: plain })
  return groups
}

function activityLabel(item: FleetItem | undefined): string {
  if (!item?.lastTool) return 'écrit la réponse'
  const tool = toolPresentation({ kind: 'tool', id: item.id, toolId: item.id, toolName: item.lastTool.toolName, input: item.lastTool.input, images: [] })
  return tool.detail ? `${tool.label} · ${tool.detail}` : tool.label
}

function groupConversationsByLatest(items: Conversation[]): ConversationGroup[] {
  if (items.length === 0) return []
  return [{
    key: 'recent',
    label: 'Récentes',
    items: [...items].sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at)),
  }]
}

export const Sidebar = memo(function Sidebar({
  selectedProject,
  quotas,
  quotaProviders,
  nudges = [],
  activeSection = null,
  onSectionSelect,
  todoCount = 0,
  selectedConversation,
  onProjectSelect,
  onConversationSelect,
  onConversationCreate,
  onConversationCreateFromContext,
  onConversationClosed,
  isCreatingConversation = false,
  onConversationRead,
  conversationListVersion,
  runningSubtasks,
  activeFleet = [],
  workspaceView,
  ticketLinks,
  sentryLinks,
}: SidebarProps) {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [error, setError] = useState<string | null>(null)
  const [conversationScope, setConversationScope] = useState<ConversationScope>('active')
  const [conversationSortMode, setConversationSortMode] = useState<ConversationSortMode>(readConversationSortMode)
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [filterText, setFilterText] = useState('')
  const [aiMode, setAiMode] = useState(false)
  const [aiSearch, setAiSearch] = useState<AiSearchState>({ status: 'idle' })
  const aiSearchControllerRef = useRef<AbortController | null>(null)
  const [openConversationMenu, setOpenConversationMenu] = useState<string | null>(null)
  const [renameConversationId, setRenameConversationId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [projectSettingsProject, setProjectSettingsProject] = useState<Project | null>(null)
  const [tidying, setTidying] = useState(false)
  const applications = useRunningApplications(15_000).items
  const selectedConversationRef = useRef(selectedConversation)
  selectedConversationRef.current = selectedConversation
  const workspaceViewRef = useRef(workspaceView)
  workspaceViewRef.current = workspaceView
  const onConversationReadRef = useRef(onConversationRead)
  onConversationReadRef.current = onConversationRead
  const isCreatingConversationRef = useRef(isCreatingConversation)
  isCreatingConversationRef.current = isCreatingConversation
  /** Armé au changement de projet, consommé au premier chargement de liste
   *  qui suit : fermer une conversation ne doit pas la faire revenir. */
  const restoreProjectIdRef = useRef<string | null>(selectedProject?.id ?? null)
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
  /** Entrées et sorties du flottant, à l'exclusion de ce qui s'y passe : un
   *  tour qui se termine écrit `answered_turn` avant de quitter le flottant,
   *  donc la liste rechargée ici voit toujours l'état final. */
  const fleetMembership = useMemo(
    () => activeFleet.map((item) => item.id).sort().join(','),
    [activeFleet],
  )
  const displayedActiveConversationIds = useMemo(() => {
    const ids = new Set(activeConversationIds)
    if (workspaceView === 'conversations' && selectedConversation !== null && runningSubtasks > 0) ids.add(selectedConversation.id)
    return ids
  }, [activeConversationIds, workspaceView, selectedConversation, runningSubtasks])
  const alwaysVisibleConversationIds = useMemo(() => {
    const ids = new Set(displayedActiveConversationIds)
    if (selectedConversation !== null) ids.add(selectedConversation.id)
    for (const conversation of conversations) {
      if (conversationRowState(conversation, displayedActiveConversationIds) === 'unread') ids.add(conversation.id)
    }
    return ids
  }, [conversations, displayedActiveConversationIds, selectedConversation])
  const nudgeByConversation = useMemo(() => {
    const byConversation = new Map<string, ConversationNudge>()
    for (const nudge of nudges) {
      if (nudge.parked === null && !byConversation.has(nudge.conversation_id)) byConversation.set(nudge.conversation_id, nudge)
    }
    return byConversation
  }, [nudges])
  const waitingSince = useMemo(() => {
    const since = new Map<string, number>()
    for (const conversation of conversations) {
      const nudge = nudgeByConversation.get(conversation.id)
      if (nudge) since.set(conversation.id, Date.parse(nudge.created_at))
      else if (conversationRowState(conversation, displayedActiveConversationIds) === 'unread') since.set(conversation.id, Date.parse(conversation.updated_at))
    }
    return since
  }, [conversations, nudgeByConversation, displayedActiveConversationIds])
  const liveSince = useMemo(() => {
    const since = new Map<string, number>()
    for (const id of displayedActiveConversationIds) {
      const startedAt = activeByConversation.get(id)?.startedAt
      since.set(id, startedAt ? Date.parse(startedAt) : Date.now())
    }
    return since
  }, [displayedActiveConversationIds, activeByConversation])
  useEffect(() => {
    let ignore = false
    if (selectedProject === null) return

    const listKey = `${selectedProject.id}:${conversationScope}`
    const cached = conversationListCache.get(listKey)
    if (cached) setConversations(cached)
    const load = () => listProjectConversations(selectedProject.id, conversationScope)
      .then((items) => {
        if (!ignore) {
          const scopedItems = items
          const currentSelectedConversation = selectedConversationRef.current
          const selectedLoadedConversation = workspaceViewRef.current === 'conversations' && currentSelectedConversation !== null
            ? scopedItems.find((item) => item.id === currentSelectedConversation.id)
            : undefined
          const shouldMarkSelectedRead = selectedLoadedConversation !== undefined
            && (selectedLoadedConversation.answered_turn ?? 0) > (selectedLoadedConversation.last_read_turn ?? 0)
          const nextItems = shouldMarkSelectedRead
            ? scopedItems.map((item) => item.id === selectedLoadedConversation.id
              ? { ...item, last_read_turn: selectedLoadedConversation.answered_turn ?? 0 }
              : item)
            : scopedItems
          const ordered = pinnedFirst(nextItems)
          conversationListCache.set(listKey, ordered)
          setConversations(ordered)
          if (shouldMarkSelectedRead) {
            void markConversationRead(
              selectedLoadedConversation.id,
              selectedLoadedConversation.answered_turn ?? 0,
            ).then(() => onConversationReadRef.current?.()).catch(() => {})
          }
          if (
            restoreProjectIdRef.current === selectedProject.id
            && conversationScope === 'active'
            && currentSelectedConversation === null
            && !isCreatingConversationRef.current
          ) {
            restoreProjectIdRef.current = null
            const storedId = readLastConversationId(selectedProject.id)
            const stored = storedId === null
              ? undefined
              : ordered.find((item) => item.id === storedId)
            if (stored !== undefined) handleConversationSelect(stored)
          }
        }
      })
      .catch((loadError: unknown) => {
        if (!ignore) setError(errorMessage(loadError))
      })
    void load()
    const timer = setInterval(() => { void load() }, 60_000)
    return () => {
      ignore = true
      clearInterval(timer)
    }
  }, [selectedProject, conversationListVersion, conversationScope, fleetMembership])

  useEffect(() => {
    restoreProjectIdRef.current = selectedProject?.id ?? null
    setFilterText('')
    setScopeMenuOpen(false)
    try {
      const stored = localStorage.getItem(`pupitre:sidebar-collapsed:${selectedProject?.id ?? ''}`)
      setCollapsedGroups(new Set(stored === null ? [] : JSON.parse(stored) as string[]))
    } catch {
      setCollapsedGroups(new Set())
    }
  }, [selectedProject?.id])

  // Revenir sur un projet, c'est reprendre son fil : la dernière conversation
  // ouverte y est retenue par projet.
  useEffect(() => {
    if (selectedProject === null || selectedConversation === null) return
    try {
      localStorage.setItem(`${LAST_CONVERSATION_KEY}${selectedProject.id}`, selectedConversation.id)
    } catch {
      // Le choix reste en mémoire si le stockage local est bloqué.
    }
  }, [selectedProject?.id, selectedConversation?.id])

  function toggleGroupExpanded(groupKey: string) {
    setExpandedGroups((current) => {
      const next = new Set(current)
      if (next.has(groupKey)) next.delete(groupKey)
      else next.add(groupKey)
      return next
    })
  }

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
    const lastReadTurn = Math.max(conversation.last_read_turn ?? 0, conversation.answered_turn ?? 0)
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
      `Activer YOLO pour « ${conversation.title} » ?\n\nL’agent ignorera les demandes de permission pour les tours suivants.`,
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
    setRenameConversationId(null)
    setRenameDraft('')
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

  function leaveAiMode() {
    aiSearchControllerRef.current?.abort()
    setAiMode(false)
    setAiSearch({ status: 'idle' })
    setFilterText('')
  }

  function runAiSearch() {
    const query = filterText.trim()
    if (selectedProject === null || query === '') return
    aiSearchControllerRef.current?.abort()
    const controller = new AbortController()
    aiSearchControllerRef.current = controller
    setAiSearch({ status: 'loading', query })
    searchConversationsWithAi(selectedProject.id, query, controller.signal)
      .then((response) => {
        if (!controller.signal.aborted) setAiSearch({ status: 'done', query, response })
      })
      .catch((searchError: unknown) => {
        if (!controller.signal.aborted) setAiSearch({ status: 'error', query, message: errorMessage(searchError) })
      })
  }

  useEffect(() => () => aiSearchControllerRef.current?.abort(), [])
  useEffect(() => {
    aiSearchControllerRef.current?.abort()
    setAiSearch({ status: 'idle' })
  }, [selectedProject?.id])

  const conversationGroups = useMemo(() => {
    const normalize = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    const terms = aiMode ? [] : normalize(filterText).trim().split(/\s+/).filter(Boolean)
    const filtered = conversations.filter((item) => (
      terms.every((term) => normalize([item.title, item.summary, item.ticket_key, item.ticket_title, item.created_on_branch, ...(item.worktree_paths ?? [])].filter(Boolean).join(' ')).includes(term))
    ))
    return conversationSortMode === 'recent'
      ? groupConversationsByLatest(filtered)
      : groupConversationsByStatus(filtered, waitingSince, liveSince)
  }, [conversations, filterText, conversationSortMode, aiMode, waitingSince, liveSince])

  const tidyCandidates = useMemo(() => {
    if (conversationScope !== 'active' || filterText.trim() !== '' || aiMode) return []
    const limit = Date.now() - TIDY_AFTER_MS
    return conversations.filter((conversation) => !conversation.pinned
      && !conversation.archived
      && !liveSince.has(conversation.id)
      && !waitingSince.has(conversation.id)
      && conversation.id !== selectedConversation?.id
      && Date.parse(conversation.updated_at) < limit)
  }, [conversations, conversationScope, filterText, aiMode, liveSince, waitingSince, selectedConversation?.id])

  async function handleTidy() {
    if (tidying || tidyCandidates.length === 0) return
    setTidying(true)
    setError(null)
    const ids = new Set<string>()
    for (const conversation of tidyCandidates) {
      try {
        await setConversationArchived(conversation.id, true)
        ids.add(conversation.id)
      } catch (tidyError: unknown) {
        setError(errorMessage(tidyError))
        break
      }
    }
    setConversations((current) => current.filter((item) => !ids.has(item.id)))
    setTidying(false)
    if (ids.size > 0) {
      pushToast({
        tone: 'ok',
        title: `${ids.size} conversation${ids.size > 1 ? 's' : ''} rangée${ids.size > 1 ? 's' : ''}`,
        detail: 'Elles restent cherchables dans le périmètre Archives.',
      })
    }
  }

  function selectConversationSortMode(mode: ConversationSortMode) {
    setConversationSortMode(mode)
    try {
      localStorage.setItem(CONVERSATION_SORT_KEY, mode)
    } catch {}
  }

  // Ouvrir une conversation depuis ailleurs (rapport, motif, ticket) doit la
  // montrer dans la liste : on déplie son groupe puis on l'amène dans la vue,
  // une seule fois par sélection pour ne pas voler le défilement ensuite.
  const conversationListRef = useRef<HTMLElement>(null)
  const revealedConversationIdRef = useRef<string | null>(null)
  useEffect(() => {
    const id = selectedConversation?.id ?? null
    if (id === null || (workspaceView !== 'conversations' && workspaceView !== 'git')) return
    if (revealedConversationIdRef.current === id) return
    const group = conversationGroups.find((item) => item.items.some((conversation) => conversation.id === id))
    if (!group) return
    if (collapsedGroups.has(group.key)) {
      toggleGroupCollapsed(group.key)
      return
    }
    const row = conversationListRef.current?.querySelector<HTMLElement>(`[data-conversation-id="${CSS.escape(id)}"]`)
    if (!row) return
    revealedConversationIdRef.current = id
    row.scrollIntoView?.({ block: 'nearest' })
  }, [selectedConversation?.id, conversationGroups, collapsedGroups, workspaceView])


  return (
    <aside className="sidebar">
      <div className="conv-sidebar-header">
        {selectedProject ? (
          <ProjectAvatar project={selectedProject} className="conv-sidebar-avatar" />
        ) : (
          <span className="conv-sidebar-avatar" aria-hidden="true">··</span>
        )}
        <div className="conv-sidebar-project" title={selectedProject ? shortenHomePath(selectedProject.path) : undefined}>
          <div className="conv-sidebar-name">
            {selectedProject ? selectedProject.name : 'Aucun projet'}
          </div>
          {selectedProject ? null : <div className="conv-sidebar-path">Choisis un projet dans le rail</div>}
        </div>

        {selectedProject && <ProjectLaunch key={selectedProject.id} project={selectedProject} conversationId={selectedConversation?.id} />}
        {selectedProject ? (
          <button
            type="button"
            className="conv-sidebar-gear"
            onClick={() => handleProjectSettings(selectedProject)}
            aria-label={`Paramètres de ${selectedProject.name}`}
            title="Paramètres du projet"
          >
            <Icon name="settings" />
          </button>
        ) : null}
      </div>
      {selectedProject ? (
        <ProjectSectionSwitch
          projectId={selectedProject.id}
          activeSection={activeSection}
          todoCount={todoCount}
          onSelect={(section) => onSectionSelect?.(section)}
        />
      ) : null}
      {selectedProject && (
        <ProjectLiveLaunches
          key={selectedProject.id}
          project={selectedProject}
          conversations={conversations}
          onConversationSelect={handleConversationSelect}
        />
      )}

      <section className="sidebar-section conversations" aria-label="Conversations du projet" ref={conversationListRef}>
          <div id="sidebar-conversations-panel">
        <div className="conversation-search-row">
          <div className={`conversation-filter-input${conversationScope !== 'active' ? ' has-scope' : ''}${aiMode ? ' is-ai' : ''}`}>
            <Icon name={aiMode ? 'spark' : 'search'} size={14} />
            <input
              type="text"
              value={filterText}
              onChange={(event) => setFilterText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && filterText.trim() !== '' && selectedProject !== null) {
                  event.preventDefault()
                  if (!aiMode) setAiMode(true)
                  runAiSearch()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  if (aiMode) leaveAiMode()
                  else setFilterText('')
                }
              }}
              placeholder={aiMode ? 'Décris la conversation, puis Entrée…' : SCOPE_PLACEHOLDERS[conversationScope]}
              aria-label={aiMode ? 'Rechercher une conversation avec l’IA' : 'Filtrer les conversations, Entrée pour chercher avec l’IA'}
            />
            {aiMode ? (
              <button type="button" className="conversation-ai-exit" onClick={leaveAiMode} aria-label="Revenir au filtre" title="Revenir au filtre (Échap)">
                <Icon name="close" size={13} />
              </button>
            ) : filterText.trim() !== '' ? (
              <span className="conversation-filter-hint" title="Entrée lance la recherche IA dans les conversations">↵ IA</span>
            ) : null}
            <button
              type="button"
              className={`conversation-scope-toggle${conversationScope !== 'active' || conversationSortMode === 'recent' ? ' is-active' : ''}`}
              aria-label="Périmètre et tri : actives, archives, corbeille"
              aria-haspopup="menu"
              aria-expanded={scopeMenuOpen}
              title="Périmètre et tri"
              onClick={() => setScopeMenuOpen((open) => !open)}
            >
              <Icon name="filter" size={14} />
            </button>
          </div>
          <button
            type="button"
            className="conversation-new-button"
            onClick={onConversationCreate}
            disabled={selectedProject === null}
            title="Nouvelle conversation dans ce projet"
            aria-label="Nouvelle conversation"
          >
            <Icon name="plus" />
          </button>
        </div>

        {scopeMenuOpen ? (
          <div className="conversation-scope-anchor">
          <div className="conversation-scope-menu" role="menu" aria-label="Périmètre et tri des conversations">
            <span className="conversation-scope-menu-label">Afficher</span>
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
            <span className="conversation-scope-menu-label">Trier</span>
            {([['context', 'Par statut et par ticket'], ['recent', 'Par activité récente']] as const).map(([mode, label]) => (
              <button
                type="button"
                key={mode}
                role="menuitemradio"
                aria-checked={conversationSortMode === mode}
                className={conversationSortMode === mode ? 'is-selected' : ''}
                onClick={() => {
                  selectConversationSortMode(mode)
                  setScopeMenuOpen(false)
                }}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  {conversationSortMode === mode ? (
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
          {aiMode && selectedProject !== null ? (
            <ConversationAiResults
              state={aiSearch}
              selectedConversationId={selectedConversation?.id ?? null}
              onSelect={handleConversationSelect}
            />
          ) : selectedProject === null ? (
            <p className="list-empty">Sélectionnez un projet</p>
          ) : conversations.length === 0 ? (
            <p className="list-empty">Aucune conversation</p>
          ) : conversationGroups.length === 0 ? (
            <p className="list-empty">Aucune conversation ne correspond</p>
          ) : (
            <>
            {conversationGroups.map((group) => {
              const isCollapsed = collapsedGroups.has(group.key)
              const groupLinks = group.ticketKey ? ticketLinks?.get(group.ticketKey) : undefined
              const backlogCount = group.items[0]?.ticket_backlog_count ?? 0
              const ticketTitle = group.ticketKey && groupLinks?.title
                ? ticketTitleWithoutKey(groupLinks.title, group.ticketKey)
                : null
              const groupSentryUrl = group.sentryKey ? sentryLinks?.get(group.sentryKey) : undefined
              const isContextual = group.kind === 'context'
              const isExpanded = expandedGroups.has(group.key)
              const compactItems = filterText.trim() !== '' ? group.items
                : isContextual ? compactGroupItems(group.items, alwaysVisibleConversationIds)
                : group.kind === 'plain' ? compactPlainItems(group.items, alwaysVisibleConversationIds)
                : group.items
              const hiddenCount = group.items.length - compactItems.length
              const shownItems = isExpanded ? group.items : compactItems
              const repeatsTicket = group.ticketKey != null
              return (
              <div className={`conv-group is-${group.kind ?? 'plain'}`} key={group.key}>
                <div className="conv-group-header">
                  <button
                    type="button"
                    className="conv-group-toggle"
                    aria-expanded={!isCollapsed}
                    aria-label={`${isCollapsed ? 'Déplier' : 'Replier'} ${group.label}`}
                    onClick={() => toggleGroupCollapsed(group.key)}
                  >
                    {isContextual ? <Icon name={isCollapsed ? 'chevron-right' : 'chevron-down'} size={12} /> : null}
                    <span className="conv-group-key" title={isContextual && backlogCount ? `${group.label} · ${backlogCount} à faire` : undefined}>{group.label}</span>
                  </button>
                  {ticketTitle ? (
                    <span className="conv-group-ticket-title" title={ticketTitle}>{ticketTitle}</span>
                  ) : <span className="conv-group-rule" aria-hidden="true" />}
                  {groupLinks ? <TicketLinkIcons links={groupLinks} ticketKey={group.ticketKey!} /> : null}
                  {groupSentryUrl !== undefined ? <SentryLinkIcon url={groupSentryUrl} issueKey={group.sentryKey!} /> : null}
                  {isContextual && onConversationCreateFromContext ? (
                    <button
                      type="button"
                      className="conv-group-create"
                      aria-label={`Nouvelle conversation dans ${group.label}`}
                      title={`Nouvelle conversation dans ${group.label}`}
                      onClick={() => {
                        const context = group.items[0]!
                        onConversationCreateFromContext({
                          ticketId: context.ticket_id,
                          ticketKey: context.ticket_key,
                          branch: context.origin_type === 'sentry' ? null : groupLinks?.branch ?? null,
                          originType: context.origin_type === 'sentry' || context.origin_type === 'problem' ? context.origin_type : null,
                          originKey: context.origin_key,
                        })
                      }}
                    ><Icon name="plus" size={13} /></button>
                  ) : null}
                  <span className={`conv-group-count${group.kind === 'waiting' ? ' is-waiting' : group.kind === 'live' ? ' is-live' : ''}`}>{group.items.length}</span>
                </div>
                {isCollapsed ? null : shownItems.map((conversation) => {
                const isSelected = (workspaceView === 'conversations' || workspaceView === 'git')
                  && selectedConversation?.id === conversation.id
                const activeItem = activeByConversation.get(conversation.id)
                const state = conversationRowState(conversation, displayedActiveConversationIds)
                const nudge = nudgeByConversation.get(conversation.id)
                const branch = branchOfWorktree(conversation.worktree_path)
                const shownTicketKey = !repeatsTicket ? conversation.ticket_key ?? null : null
                const shownBranch = state === 'live' ? null : workBranchLabel(conversation, branch, selectedProject?.detected_trunk)
                const ports = applicationsForConversation(applications, conversation).slice(0, 2)
                const portChips = ports.map((application) => (
                  <PortChip key={application.port} application={application} projectName={selectedProject?.name ?? ''} inert />
                ))
                let secondLine: ReactNode = null
                if (state === 'live') {
                  secondLine = (
                    <span className="conv-row-line2 is-live">
                      <span className="conv-row-dots" aria-hidden="true"><i /><i /><i /></span>
                      <span className="conv-row-activity-label">{activityLabel(activeItem)}</span>
                      {portChips}
                    </span>
                  )
                } else if (nudge) {
                  secondLine = <span className="conv-row-line2 is-waiting" title={nudge.body || nudge.title}>{nudge.title}</span>
                } else if (state === 'unread') {
                  secondLine = (
                    <span className="conv-row-line2 is-unread">
                      Réponse à lire
                      {shownTicketKey ? <span className="conv-row-ticket">{shownTicketKey}</span> : null}
                    </span>
                  )
                } else if (shownTicketKey || shownBranch || ports.length > 0) {
                  secondLine = (
                    <span className="conv-row-line2">
                      {shownTicketKey ? (
                        <span className="conv-row-ticket" title={`${shownTicketKey} · ${conversation.ticket_title ?? ''}`}>{shownTicketKey}</span>
                      ) : null}
                      {shownBranch ? (
                        <span className="conv-row-branch" title={shownBranch.title}>
                          <Icon name="branch" size={12} />{shownBranch.label}
                        </span>
                      ) : null}
                      {portChips}
                    </span>
                  )
                }
                return (
              <div
                className={`navigation-row conv-row-state-${state}${nudge ? ' is-waiting' : ''}${conversation.origin_type === 'sentry' ? ' conv-row-sentry' : ''}${conversation.pinned ? ' is-pinned' : ''} ${isSelected ? 'is-selected' : ''}`}
                key={conversation.id}
                data-conversation-id={conversation.id}
              >
                <span className={`conv-row-edge ${state === 'unread' || nudge ? 'is-visible' : ''}`} aria-hidden="true" />
                <span className={`conv-row-land ${state === 'unread' ? 'is-visible' : ''}`} aria-hidden="true" />
                <button
                  type="button"
                  className="navigation-main"
                  onClick={() => handleConversationSelect(conversation)}
                >
                  <span className="conv-row-line1">
                    {conversation.origin_type === 'sentry' ? (
                      <ProviderMark provider="sentry" className="conv-row-mark" />
                    ) : <ProviderMark provider={conversation.provider} className="conv-row-mark" />}
                    {conversation.pinned ? <span className="conv-row-pin" title="Épinglée"><Icon name="pin" size={12} /></span> : null}
                    <span className="conv-row-title">{conversation.title}</span>
                    <span className="conv-row-time">
                      {state === 'live'
                        ? elapsedConversationTime(activeItem?.startedAt, now)
                        : shortConversationTime(conversation.updated_at)}
                    </span>
                  </span>
                  {secondLine}
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
                    <Icon name="pin" size={14} />
                  </button>
                  <button
                    type="button"
                    className="conversation-more-button"
                    aria-label={`Actions pour ${conversation.title}`}
                    aria-expanded={openConversationMenu === conversation.id}
                    onClick={() => {
                      setOpenConversationMenu((current) => current === conversation.id ? null : conversation.id)
                    }}
                  >
                    <Icon name="more" size={15} />
                  </button>
                  {openConversationMenu === conversation.id ? (
                    <div className="conversation-actions-menu" role="menu">
                      <button type="button" role="menuitem" onClick={() => startRename(conversation)}>Renommer</button>
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
              </div>
                )
                })}
                {!isCollapsed && (hiddenCount > 0 || isExpanded) ? (
                  <button
                    type="button"
                    className="conv-group-more"
                    aria-expanded={isExpanded}
                    onClick={() => toggleGroupExpanded(group.key)}
                  >
                    <Icon name={isExpanded ? 'chevron-up' : 'chevron-down'} size={13} />
                    {isExpanded ? 'Réduire' : `${hiddenCount} ${group.kind === 'plain' ? 'plus ancienne' : 'autre'}${hiddenCount > 1 ? 's' : ''}`}
                  </button>
                ) : null}
              </div>
              )
            })}
            {tidyCandidates.length > 0 && conversationSortMode === 'context' ? (
              <div className="conversation-tidy">
                <Icon name="archive" size={14} />
                <span><strong>{tidyCandidates.length}</strong> sans activité depuis 7 jours</span>
                <button type="button" onClick={() => void handleTidy()} disabled={tidying}>
                  {tidying ? 'Rangement…' : 'Ranger'}
                </button>
              </div>
            ) : null}
            </>
          )}
        </div>
          </div>
      </section>

      {error && (
        <p className="sidebar-error" role="alert">
          {error}
        </p>
      )}

      {projectSettingsProject ? (
        <ProjectSettingsDialog
          key={projectSettingsProject.id}
          project={projectSettingsProject}
          onClose={() => setProjectSettingsProject(null)}
          onUpdated={handleProjectSettingsUpdated}
        />
      ) : null}

      {quotas && quotaProviders?.length !== 0 ? (
        <div className="sidebar-footer sidebar-footer--compact">
          <div className="sidebar-quotas">
            <QuotaStatus snapshot={quotas} providers={quotaProviders} />
          </div>
        </div>
      ) : null}
    </aside>
  )
})
