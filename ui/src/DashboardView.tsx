import { useEffect, useMemo, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { BranchIcon } from './BranchIcon'
import { TicketLinkIcons } from './TicketLinkIcons'
import { gitlabContextOf, ticketLinksOf } from './ticketLinks'
import { getSentryInbox, listProjectChangelog, refreshProjectChangelog, refreshProjectDashboard, updateTicketInstruction } from './api'
import type {
  DashboardIntegration,
  Project,
  ProjectChangelogEntry,
  ProjectChangelogState,
  ReviewRequest,
  TicketConversationSummary,
  TicketRef,
  TicketRow,
} from './types'
import { useDashboard } from './useDashboard'
import { SentryInbox } from './SentryInbox'
import { ExternalLink } from './externalLink'
import { useNow } from './useNow'

interface DashboardViewProps {
  embedded?: boolean
  project: Project
  onConversationSelect: (conversationId: string) => void
  onStartConversation: (seed: { ticketId: string; branch: string | null; ticketKey: string }) => void
  onOpenSettings?: () => void
  todoPanel?: ReactNode | ((hasTicketIntegration: boolean) => ReactNode)
  todoCount?: number
  todoPanelRequest?: number
  onCreateTodoFromTicket?: (ticket: TicketRow) => void
  onRefreshTodos?: () => void
}

type DashboardTab = 'todos' | 'tickets' | 'sentry' | 'changelog' | 'environments'

const DASHBOARD_TABS: ReadonlyArray<{ id: DashboardTab; label: string }> = [
  { id: 'todos', label: 'Tâches' },
  { id: 'tickets', label: 'Mes tickets' },
  { id: 'sentry', label: 'Issues Sentry' },
  { id: 'changelog', label: 'Changelog' },
  { id: 'environments', label: 'Environnements' },
]

const PROJECT_PANEL_LABELS: Record<DashboardTab, string> = { todos: 'Tâches', tickets: 'Tickets', sentry: 'Sentry', changelog: 'Changelog', environments: 'Environnements' }

const PROJECT_SECTION_ICONS: Record<DashboardTab, ReactNode> = {
  todos: <path d="m2.5 4 1.2 1.2L6 2.9M8 4h5M2.5 8h3M8 8h5M2.5 12h3M8 12h5" />,
  tickets: <><rect x="2" y="4" width="12" height="8" rx="1.5" /><path d="M2 7h12" /></>,
  sentry: <path d="M8 2.5 13.5 12H10a2 2 0 0 0-2-2 2 2 0 0 0-2 2H2.5Z" />,
  changelog: <path d="M3 4.5h10M3 8h7M3 11.5h9" />,
  environments: <><rect x="2.5" y="3" width="11" height="4" rx="1" /><rect x="2.5" y="9" width="11" height="4" rx="1" /><path d="M5 5h.01M5 11h.01" /></>,
}

function dashboardTabStorageKey(projectId: string): string {
  return `pupitre:dashboard-tab:${projectId}`
}

function storedDashboardTab(projectId: string): DashboardTab {
  const stored = window.localStorage.getItem(dashboardTabStorageKey(projectId))
  return DASHBOARD_TABS.some((tab) => tab.id === stored) ? stored as DashboardTab : 'todos'
}

const INTEGRATION_LABEL: Record<string, string> = {
  clickup: 'ClickUp',
  gitlab: 'GitLab',
  github: 'GitHub',
  notion: 'Notion',
  sentry: 'Sentry',
}

function ClickUpIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#ff02f0" d="M2.4 8.3 12.1 0l9.5 8.3-3.1 3.5-6.5-5.7-6.6 5.7Z" />
      <path fill="#7b68ee" d="m2 18.4 3.7-2.8c2 2.6 4 3.8 6.4 3.8 2.3 0 4.3-1.2 6.2-3.7l3.7 2.7c-2.7 3.7-6.1 5.6-10 5.6-3.8 0-7.2-1.9-10-5.6Z" />
    </svg>
  )
}

type TicketSortKey = 'ticket' | 'status' | 'updated' | 'conversation'

const TICKET_SORTS: ReadonlyArray<{ key: TicketSortKey; label: string; hint: string }> = [
  { key: 'ticket', label: 'Numéro', hint: 'Trier par numéro de ticket' },
  { key: 'updated', label: 'Mise à jour', hint: 'Trier par date de mise à jour du ticket' },
  { key: 'conversation', label: 'Conversation', hint: 'Trier par date de la dernière conversation créée' },
]

function ticketUpdatedAt(ticket: TicketRow): number {
  return Date.parse(textValue(ticket.payload.updatedAt) ?? ticket.updated_at) || 0
}

/** Le sidecar antérieur à la colonne `created_at` ne sert que `updated_at`. */
function lastConversationAt(ticket: TicketRow): number {
  return ticket.conversations.reduce(
    (latest, conversation) => Math.max(latest, Date.parse(conversation.created_at ?? conversation.updated_at) || 0),
    0,
  )
}

/** Les statuts arrivent tels que ClickUp les écrit, en minuscules. */
function statusLabel(status: string): string {
  return status ? status.charAt(0).toUpperCase() + status.slice(1) : '—'
}

function refOf(ticket: TicketRow, kind: TicketRef['kind']): TicketRef | undefined {
  return ticket.refs.find((ref) => ref.kind === kind)
}

function textValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

interface StatusPresentation {
  label: string
  tone: 'is-ok' | 'is-danger' | 'is-warn' | 'is-info' | 'is-neutral'
  explanation: string
}

function pipelinePresentation(ref: TicketRef | undefined): StatusPresentation | null {
  const status = textValue(ref?.payload.status)
  if (!status) return null
  if (status === 'success') return { label: 'Réussi', tone: 'is-ok', explanation: 'Le pipeline s’est terminé avec succès.' }
  if (status === 'failed') return { label: 'Échec', tone: 'is-danger', explanation: 'Le pipeline a échoué.' }
  if (status === 'running') return { label: 'En cours', tone: 'is-info', explanation: 'Le pipeline est en cours d’exécution.' }
  if (status === 'manual') return { label: 'Action requise', tone: 'is-warn', explanation: 'Une action manuelle est nécessaire pour poursuivre le pipeline.' }
  if (status === 'pending' || status === 'created' || status === 'preparing') return { label: 'En attente', tone: 'is-warn', explanation: 'Le pipeline attend son exécution.' }
  if (status === 'canceled' || status === 'skipped') return { label: status === 'canceled' ? 'Annulé' : 'Ignoré', tone: 'is-neutral', explanation: `Pipeline ${status === 'canceled' ? 'annulé' : 'ignoré'}.` }
  return { label: status, tone: 'is-neutral', explanation: `État GitLab : ${status}.` }
}

function relative(value: string | null | undefined): string {
  if (!value) return '—'
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return '—'
  const deltaMinutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000))
  if (deltaMinutes < 60) return `${deltaMinutes} min`
  const deltaHours = Math.round(deltaMinutes / 60)
  if (deltaHours < 48) return `${deltaHours} h`
  return `${Math.round(deltaHours / 24)} j`
}

function deploymentLabel(ref: TicketRef | undefined): string {
  if (!ref) return '—'
  const environment = textValue(ref.payload.environment)
  const user = textValue(ref.payload.user)
  if (environment && user) return `${environment} · ${user}`
  return environment ?? user ?? ref.ref
}

function mrPresentation(ref: TicketRef | undefined): StatusPresentation | null {
  if (!ref) return null
  const mergeStatus = textValue(ref.payload.mergeStatus)
  if (ref.payload.hasConflicts === true || mergeStatus === 'conflict') {
    return { label: 'Conflits', tone: 'is-danger', explanation: 'La branche contient des conflits à résoudre avant la fusion.' }
  }
  if (mergeStatus === 'mergeable') return { label: 'Fusionnable', tone: 'is-ok', explanation: 'GitLab autorise la fusion de cette MR.' }
  if (mergeStatus === 'unchecked' || mergeStatus === 'checking') {
    return { label: 'Vérification en attente', tone: 'is-neutral', explanation: 'GitLab n’a pas encore calculé si cette MR peut être fusionnée.' }
  }
  if (mergeStatus === 'ci_still_running') return { label: 'CI en cours', tone: 'is-info', explanation: 'La fusion attend la fin de la CI.' }
  if (mergeStatus === 'not_approved' || mergeStatus === 'approvals_syncing') return { label: 'Approbation requise', tone: 'is-warn', explanation: 'La MR attend une approbation.' }
  const state = textValue(ref.payload.state)
  return { label: mergeStatus ?? state ?? ref.ref, tone: 'is-neutral', explanation: `État GitLab : ${mergeStatus ?? state ?? ref.ref}.` }
}

function reviewLabel(review: ReviewRequest): string {
  return `${review.project}!${review.iid}`
}

function conversationSummary(conversation: TicketConversationSummary): string {
  const branch = conversation.worktree_path?.split(/[\\/]/).pop() ?? null
  return branch ? `${conversation.provider} · ${branch}` : conversation.provider
}

function bannerTone(integration: DashboardIntegration): string {
  if (integration.status === 'ok') return ''
  if (integration.status === 'hors ligne' || integration.status === 'à reconfigurer') return ' is-danger'
  return ' is-warn'
}

function changelogTiming(state: ProjectChangelogState | null, now: number): string {
  if (state?.status === 'running') return 'Actualisation en cours'
  if (!state?.next_refresh_at) return 'Jamais actualisé'
  const remaining = Date.parse(state.next_refresh_at) - now
  if (remaining <= 0) return 'Actualisation imminente'
  const minutes = Math.ceil(remaining / 60_000)
  const delay = minutes < 60
    ? `${minutes} min`
    : `${Math.floor(minutes / 60)} h ${minutes % 60} min`
  return state.status === 'error'
    ? `Dernière actualisation en échec · prochain essai dans ${delay}`
    : `Prochaine actualisation dans ${delay}`
}

export function DashboardView({
  project,
  onConversationSelect,
  onStartConversation,
  onOpenSettings,
  todoPanel,
  todoCount = 0,
  todoPanelRequest = 0,
  onCreateTodoFromTicket,
  onRefreshTodos,
  embedded = false,
}: DashboardViewProps) {
  const { data, connected, error } = useDashboard(project.id)
  const [openConversations, setOpenConversations] = useState<Record<string, boolean>>({})
  const [instructionTicket, setInstructionTicket] = useState<TicketRow | null>(null)
  const [instructionDraft, setInstructionDraft] = useState('')
  const [instructionSaving, setInstructionSaving] = useState(false)
  const [instructionError, setInstructionError] = useState<string | null>(null)
  const [sort, setSort] = useState<{ key: TicketSortKey; direction: 'asc' | 'desc' }>({ key: 'ticket', direction: 'asc' })
  const [changelog, setChangelog] = useState<ProjectChangelogEntry[]>([])
  const [changelogState, setChangelogState] = useState<ProjectChangelogState | null>(null)
  const [changelogDomain, setChangelogDomain] = useState('')
  const [changelogMenuOpen, setChangelogMenuOpen] = useState(false)
  /* Le compteur du rail : l'inbox Sentry n'est pas dans le payload du
     tableau de bord, et la section ne se monte qu'une fois ouverte. */
  const [sentryCount, setSentryCount] = useState(0)
  const [tabSelection, setTabSelection] = useState(() => ({
    projectId: project.id,
    request: todoPanelRequest,
    tab: todoPanelRequest > 0 ? 'todos' as DashboardTab : storedDashboardTab(project.id),
  }))
  if (tabSelection.projectId !== project.id || tabSelection.request !== todoPanelRequest) {
    setTabSelection({
      projectId: project.id,
      request: todoPanelRequest,
      tab: tabSelection.request !== todoPanelRequest ? 'todos' : storedDashboardTab(project.id),
    })
  }
  const now = useNow(30_000)
  const hasGitlab = data?.integrations.some((integration) => integration.type === 'gitlab') ?? false
  const hasSentry = data?.integrations.some((integration) => integration.type === 'sentry') ?? false
  const hasTicketIntegration = data?.integrations.some((integration) => ['clickup', 'notion', 'gitlab'].includes(integration.type)) ?? false
  const visibleTabs = DASHBOARD_TABS.filter((tab) => (tab.id !== 'tickets' || hasTicketIntegration) && (tab.id !== 'sentry' || hasSentry))
  const activeTab = visibleTabs.some((tab) => tab.id === tabSelection.tab) ? tabSelection.tab : 'todos'
  const degradedIntegrations = data?.integrations.filter((integration) => integration.status !== 'ok') ?? []
  const tableClassName = useMemo(
    () => `dashboard-table${hasGitlab ? ' dashboard-table--with-gitlab' : ''}`,
    [hasGitlab],
  )
  const changelogDomains = useMemo(() => [...new Map(changelog
    .filter((item): item is ProjectChangelogEntry & { domain_id: string; domain_name: string } => Boolean(item.domain_id && item.domain_name))
    .map((item) => [item.domain_id, item.domain_name])).entries()], [changelog])
  const visibleChangelog = changelogDomain ? changelog.filter((item) => item.domain_id === changelogDomain) : changelog
  const changelogHasMultipleRepositories = new Set(changelog.map((item) => item.repository_path)).size > 1
  const sortedTickets = useMemo(() => {
    const byKey = (left: TicketRow, right: TicketRow) => left.key.localeCompare(right.key, 'fr', { numeric: true })
    return [...(data?.tickets ?? [])].sort((left, right) => {
      let comparison: number
      if (sort.key === 'status') comparison = left.status.localeCompare(right.status, 'fr', { sensitivity: 'base' }) || byKey(left, right)
      else if (sort.key === 'updated') comparison = ticketUpdatedAt(left) - ticketUpdatedAt(right) || byKey(left, right)
      else if (sort.key === 'conversation') comparison = lastConversationAt(left) - lastConversationAt(right) || byKey(left, right)
      else comparison = byKey(left, right)
      return sort.direction === 'asc' ? comparison : -comparison
    })
  }, [data?.tickets, sort])

  useEffect(() => {
    let cancelled = false
    void listProjectChangelog(project.id).then((payload) => {
      if (!cancelled && Array.isArray(payload.entries)) {
        setChangelog(payload.entries)
        setChangelogState(payload.state)
      }
    }).catch(() => {})
    return () => { cancelled = true }
  }, [project.id])

  useEffect(() => {
    if (!embedded || !hasSentry) return
    const controller = new AbortController()
    void getSentryInbox(project.id, controller.signal)
      .then((payload) => { if (!controller.signal.aborted) setSentryCount(payload.issues.length) })
      .catch(() => {})
    return () => controller.abort()
  }, [project.id, embedded, hasSentry])

  useEffect(() => {
    let cancelled = false
    const delay = changelogState?.status === 'running' ? 2_000 : 30_000
    const timer = setInterval(() => {
      void listProjectChangelog(project.id).then((payload) => {
        if (!cancelled && Array.isArray(payload.entries)) {
          setChangelog(payload.entries)
          setChangelogState(payload.state)
        }
      }).catch(() => {})
    }, delay)
    return () => { cancelled = true; clearInterval(timer) }
  }, [project.id, changelogState?.status])

  async function handleRefresh() {
    try {
      await refreshProjectDashboard(project.id)
    } catch {}
  }

  async function handleChangelogRefresh() {
    setChangelogMenuOpen(false)
    try {
      setChangelogState(await refreshProjectChangelog(project.id))
    } catch {}
  }

  function showChangelog() {
    setChangelogMenuOpen(false)
    selectTab('changelog')
  }

  function selectTab(tab: DashboardTab) {
    setTabSelection({ projectId: project.id, request: todoPanelRequest, tab })
    window.localStorage.setItem(dashboardTabStorageKey(project.id), tab)
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, tab: DashboardTab) {
    const index = visibleTabs.findIndex((candidate) => candidate.id === tab)
    let nextIndex: number | null = null
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % visibleTabs.length
    else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + visibleTabs.length) % visibleTabs.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = visibleTabs.length - 1
    if (nextIndex === null) return
    event.preventDefault()
    const nextTab = visibleTabs[nextIndex]!
    event.currentTarget.parentElement
      ?.querySelector<HTMLButtonElement>(`#${embedded ? 'project-section' : 'dashboard-tab'}-${nextTab.id}`)
      ?.focus()
    selectTab(nextTab.id)
  }

  function handleSort(key: TicketSortKey) {
    setSort((current) => current.key === key
      ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
      : { key, direction: key === 'ticket' || key === 'status' ? 'asc' : 'desc' })
  }

  function openInstruction(ticket: TicketRow) {
    setInstructionTicket(ticket)
    setInstructionDraft(ticket.instruction)
    setInstructionError(null)
  }

  async function handleSaveInstruction() {
    if (!instructionTicket || instructionSaving) return
    setInstructionSaving(true)
    setInstructionError(null)
    try {
      await updateTicketInstruction(instructionTicket.id, instructionDraft)
      setInstructionTicket(null)
    } catch (saveError) {
      setInstructionError(saveError instanceof Error ? saveError.message : 'Impossible d’enregistrer l’instruction.')
    } finally {
      setInstructionSaving(false)
    }
  }

  const gitlab = gitlabContextOf({ integrations: data?.integrations ?? [], gitlabUsername: data?.gitlabUsername ?? null })
  const sectionCounts: Partial<Record<DashboardTab, number>> = {
    todos: todoCount,
    tickets: data?.tickets.length ?? 0,
    sentry: sentryCount,
  }

  function refreshActiveTab() {
    if (activeTab === 'todos') onRefreshTodos?.()
    else if (activeTab === 'changelog') void handleChangelogRefresh()
    else void handleRefresh()
  }

  return (
    <section
      className={`dashboard-view${embedded ? ' is-sectioned' : ''}`}
      aria-label={embedded ? 'Suivi du projet' : undefined}
      aria-labelledby={embedded ? undefined : 'dashboard-title'}
    >
      {embedded ? (
        <nav className="project-sections" aria-label="Sections du projet">
          <div className="project-sections-list" role="tablist" aria-orientation="horizontal" aria-label="Sections du projet">
            {visibleTabs.map((section) => {
              const count = sectionCounts[section.id] ?? 0
              return (
                <button
                  key={section.id}
                  id={`project-section-${section.id}`}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === section.id}
                  aria-controls={`dashboard-panel-${section.id}`}
                  tabIndex={activeTab === section.id ? 0 : -1}
                  className={activeTab === section.id ? 'is-selected' : ''}
                  title={PROJECT_PANEL_LABELS[section.id]}
                  aria-label={`${PROJECT_PANEL_LABELS[section.id]}${count > 0 ? ` ${count}` : ''}`}
                  onClick={() => selectTab(section.id)}
                  onKeyDown={(event) => handleTabKeyDown(event, section.id)}
                >
                  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <g stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                      {PROJECT_SECTION_ICONS[section.id]}
                    </g>
                  </svg>
                  <span>{PROJECT_PANEL_LABELS[section.id]}</span>
                  {count > 0 ? <span className={`project-section-count${section.id === 'sentry' ? ' is-alert' : ''}`}>{count}</span> : null}
                </button>
              )
            })}
          </div>
          <button
            type="button"
            className="project-sections-refresh"
            aria-label="Actualiser"
            onClick={refreshActiveTab}
          >
            <span>Actualiser</span>
          </button>
        </nav>
      ) : null}
      <div className="dashboard-scroll">
        {embedded ? null : <header className="dashboard-header">
          <div className="dashboard-heading">
            <h1 id="dashboard-title">Tableau de bord</h1>
            <p className="dashboard-baseline">{project.name}</p>
          </div>
          <div className="dashboard-header-actions">
            <span className={`dashboard-connection ${connected ? 'is-live' : ''}`}>
              <i aria-hidden="true" /> {connected ? 'temps réel' : 'reconnexion'}
            </span>
            <div
              className="dashboard-changelog-menu"
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setChangelogMenuOpen(false)
              }}
            >
              <button
                type="button"
                className="secondary-button"
                aria-haspopup="menu"
                aria-expanded={changelogMenuOpen}
                title={changelogTiming(changelogState, now)}
                onClick={() => setChangelogMenuOpen((open) => !open)}
              >
                Changelog <span aria-hidden="true">⌄</span>
              </button>
              {changelogMenuOpen ? (
                <div className="dashboard-changelog-dropdown" role="menu">
                  <button type="button" role="menuitem" onClick={showChangelog}>Voir le changelog</button>
                  <button type="button" role="menuitem" disabled={changelogState?.status === 'running'} onClick={() => void handleChangelogRefresh()}>
                    {changelogState?.status === 'running' ? 'Actualisation en cours…' : 'Actualiser le changelog'}
                  </button>
                  <small>{changelogTiming(changelogState, now)}</small>
                </div>
              ) : null}
            </div>
            <button type="button" className="secondary-button" onClick={refreshActiveTab}>
              Rafraîchir
            </button>
          </div>
        </header>}

        {error ? <p className="dashboard-banner is-danger">Tableau indisponible : {error}</p> : null}

        {degradedIntegrations.map((integration) => (
          <p key={integration.id} className={`dashboard-banner${bannerTone(integration)}`}>
            {INTEGRATION_LABEL[integration.type] ?? integration.type}
            {` : ${integration.status}`}
            {integration.last_error ? ` — ${integration.last_error}` : ''}
            {integration.status !== 'ok' && integration.last_ok_at ? ` · dernière relève réussie le ${new Date(integration.last_ok_at).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : ''}
            {integration.status === 'non configurée' && onOpenSettings ? (
              <>
                {' '}
                <button type="button" className="text-button" onClick={onOpenSettings}>Configurer</button>
              </>
            ) : null}
          </p>
        ))}

        {!embedded ? <div className="dashboard-tabs" role="tablist" aria-label="Sections du tableau de bord">
          {visibleTabs.map((tab) => (
            <button
              key={tab.id}
              id={`dashboard-tab-${tab.id}`}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              aria-controls={`dashboard-panel-${tab.id}`}
              tabIndex={activeTab === tab.id ? 0 : -1}
              onKeyDown={(event) => handleTabKeyDown(event, tab.id)}
              onClick={() => selectTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div> : null}

        {activeTab === 'todos' ? (
          <section id="dashboard-panel-todos" role="tabpanel" aria-labelledby={embedded ? 'project-section-todos' : 'dashboard-tab-todos'} className="dashboard-todos">
            {typeof todoPanel === 'function' ? todoPanel(hasTicketIntegration) : todoPanel}
          </section>
        ) : null}

        {activeTab === 'tickets' ? (
        <section id="dashboard-panel-tickets" role="tabpanel" aria-labelledby={embedded ? 'project-section-tickets' : 'dashboard-tab-tickets'} className="dashboard-section">
          <div className="dashboard-section-head">
            {embedded ? (
              <>
                <p className="project-ticket-caption">Tickets synchronisés avec ce projet</p>
                <div className="project-ticket-sort" role="group" aria-label="Trier les tickets">
                  {TICKET_SORTS.map((option) => (
                    <button
                      key={option.key}
                      type="button"
                      className={sort.key === option.key ? 'is-active' : ''}
                      aria-pressed={sort.key === option.key}
                      title={option.hint}
                      onClick={() => handleSort(option.key)}
                    >
                      {option.label}
                      {sort.key === option.key ? <i aria-hidden="true">{sort.direction === 'asc' ? '↑' : '↓'}</i> : null}
                    </button>
                  ))}
                </div>
              </>
            ) : <h2 className="dashboard-section-title">Mes tickets</h2>}
          </div>

          {data === null ? null : data.tickets.length === 0 ? (
            <div className="dashboard-empty">
              <strong>Aucun ticket pour ce projet</strong>
              <p>Les tickets de tes intégrations apparaîtront ici.</p>
            </div>
          ) : embedded ? <div className="project-ticket-list">{sortedTickets.map((ticket) => {
            const links = ticketLinksOf(ticket, gitlab)
            const mergeRequestStatus = mrPresentation(refOf(ticket, 'mr'))
            const statusColor = textValue(ticket.payload.statusColor) ?? 'var(--text-faint)'
            return <article className="project-ticket" key={ticket.id} style={{ '--ticket-status': statusColor } as CSSProperties}>
              <div className="project-ticket-head">
                <strong>{ticket.key}</strong>
                <TicketLinkIcons links={links} ticketKey={ticket.key} />
                <span className="project-ticket-status" title={ticket.status}>{statusLabel(ticket.status)}</span>
              </div>
              <p className="project-ticket-title">{ticket.title}</p>
              {links.branch || mergeRequestStatus || ticket.conversations.length > 0 ? (
                <div className="project-ticket-refs">
                  {links.branch ? <span className="project-ticket-branch"><BranchIcon /> {links.branch}</span> : null}
                  {mergeRequestStatus ? <span className={`dashboard-state ${mergeRequestStatus.tone}`} title={mergeRequestStatus.explanation}>{mergeRequestStatus.label}</span> : null}
                  {ticket.conversations.length > 0 ? (
                    <button
                      type="button"
                      className="project-ticket-toggle"
                      aria-expanded={Boolean(openConversations[ticket.id])}
                      aria-controls={`project-ticket-${ticket.id}-conversations`}
                      onClick={() => setOpenConversations((current) => ({ ...current, [ticket.id]: !current[ticket.id] }))}
                    >
                      {ticket.conversations.length} conversation{ticket.conversations.length > 1 ? 's' : ''}
                      <svg viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
                    </button>
                  ) : null}
                </div>
              ) : null}
              {ticket.instruction ? (
                <button
                  type="button"
                  className="project-ticket-instruction"
                  title="Instruction injectée dans chaque nouvelle conversation reliée à ce ticket."
                  onClick={() => openInstruction(ticket)}
                >
                  {ticket.instruction}
                </button>
              ) : null}
              <div className="project-ticket-actions">
                <button
                  type="button"
                  className="project-ticket-action is-primary"
                  onClick={() => onStartConversation({ ticketId: ticket.id, ticketKey: ticket.key, branch: links.branch })}
                >
                  Nouvelle conversation
                </button>
                {onCreateTodoFromTicket ? (
                  <button type="button" className="project-ticket-action" onClick={() => onCreateTodoFromTicket(ticket)}>
                    Créer une tâche
                  </button>
                ) : null}
                <button
                  type="button"
                  className="project-ticket-action"
                  title="Instruction injectée dans chaque nouvelle conversation reliée à ce ticket."
                  onClick={() => openInstruction(ticket)}
                >
                  {ticket.instruction ? 'Modifier l’instruction' : 'Ajouter une instruction'}
                </button>
              </div>
              {openConversations[ticket.id] ? (
                <div className="project-ticket-conversations" id={`project-ticket-${ticket.id}-conversations`}>
                  {ticket.conversations.map((conversation) => <button key={conversation.id} type="button" className="project-ticket-conversation" onClick={() => onConversationSelect(conversation.id)}>{conversation.title} →</button>)}
                </div>
              ) : null}
            </article>
          })}</div> : (
            <div className={tableClassName} role="region" aria-label="Mes tickets">
              <div className="dashboard-row dashboard-head">
                <span aria-sort={sort.key === 'ticket' ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
                  <button type="button" className="dashboard-sort-button" onClick={() => handleSort('ticket')}>Ticket <i aria-hidden="true">{sort.key === 'ticket' ? (sort.direction === 'asc' ? '↑' : '↓') : '↕'}</i></button>
                </span>
                <span aria-sort={sort.key === 'status' ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
                  <button type="button" className="dashboard-sort-button" onClick={() => handleSort('status')}>Statut <i aria-hidden="true">{sort.key === 'status' ? (sort.direction === 'asc' ? '↑' : '↓') : '↕'}</i></button>
                </span>
                <span>Branche</span>
                <span>MR</span>
                <span>Pipeline</span>
                {hasGitlab ? <span>Déployé</span> : null}
                <span>Conversations</span>
                <span>Actions</span>
              </div>

              {sortedTickets.map((ticket) => {
                const branch = refOf(ticket, 'branch')
                const mergeRequest = refOf(ticket, 'mr')
                const pipeline = refOf(ticket, 'pipeline')
                const deployment = refOf(ticket, 'deployment')
                const pipelineStatus = pipelinePresentation(pipeline)
                const mergeRequestStatus = mrPresentation(mergeRequest)
                const pipelineUrl = textValue(pipeline?.payload.url)
                const mergeRequestUrl = textValue(mergeRequest?.payload.url)
                const externalUrl = ticket.external_url

                return (
                  <div className="dashboard-row" key={ticket.id}>
                      <span className="dashboard-ticket">
                        <span className="dashboard-ticket-heading">
                          <strong className="dashboard-key">{ticket.key}</strong>
                          {externalUrl ? (
                            <ExternalLink className="dashboard-ticket-link" href={externalUrl} ariaLabel={`Ouvrir ${ticket.key} dans ClickUp`} title="Ouvrir dans ClickUp"><ClickUpIcon /></ExternalLink>
                          ) : null}
                        </span>
                        <small>{ticket.title}</small>
                      </span>

                      <span className="dashboard-status">
                        <i
                          className="dashboard-status-dot"
                          aria-hidden="true"
                          style={{ background: textValue(ticket.payload.statusColor) ?? 'var(--text-faint)' }}
                        />
                        {statusLabel(ticket.status)}
                      </span>

                      <span className="dashboard-branch">
                        {branch ? (
                          <>
                            <BranchIcon />
                            <span>{branch.ref}</span>
                          </>
                        ) : '—'}
                      </span>

                      <span className="dashboard-link">
                        {mergeRequest && mergeRequestUrl ? (
                          <ExternalLink
                            href={mergeRequestUrl}
                            ariaLabel={`MR ${mergeRequest.ref}`}
                          >
                            <span>{mergeRequest.ref}</span>
                            {mergeRequestStatus ? <small className={`dashboard-state ${mergeRequestStatus.tone}`} title={mergeRequestStatus.explanation}>{mergeRequestStatus.label}</small> : null}
                          </ExternalLink>
                        ) : '—'}
                      </span>

                      <span className="dashboard-pipeline">
                        {pipeline && pipelineUrl && pipelineStatus ? (
                          <ExternalLink className={`dashboard-state ${pipelineStatus.tone}`} href={pipelineUrl} title={pipelineStatus.explanation}>{pipelineStatus.label}</ExternalLink>
                        ) : (
                          pipelineStatus ? <span className={`dashboard-state ${pipelineStatus.tone}`} title={pipelineStatus.explanation}>{pipelineStatus.label}</span> : '—'
                        )}
                      </span>

                      {hasGitlab ? <span>{deploymentLabel(deployment)}</span> : null}

                      <span>
                        {ticket.conversations.length === 0 ? (
                          <span className="dashboard-conversation-count">0</span>
                        ) : (
                          <div className="dashboard-conversations">
                            <button
                              type="button"
                              className="text-button"
                              aria-label={`Conversations (${ticket.conversations.length})`}
                              aria-expanded={Boolean(openConversations[ticket.id])}
                              aria-controls={`ticket-${ticket.id}-conversations`}
                              onClick={() => setOpenConversations((current) => ({
                                ...current,
                                [ticket.id]: !current[ticket.id],
                              }))}
                            >
                              {ticket.conversations.length}
                            </button>
                            {openConversations[ticket.id] ? (
                              <ul id={`ticket-${ticket.id}-conversations`} className="dashboard-conversation-list">
                                {ticket.conversations.map((conversation) => (
                                  <li key={conversation.id}>
                                    <button
                                      type="button"
                                      className="text-button"
                                      onClick={() => onConversationSelect(conversation.id)}
                                    >
                                      <span>{conversation.title}</span>
                                      <small>{conversationSummary(conversation)}</small>
                                    </button>
                                  </li>
                                ))}
                              </ul>
                            ) : null}
                          </div>
                        )}
                      </span>

                      <span className="dashboard-actions">
                        <button
                          type="button"
                          className="primary-button"
                          onClick={() => onStartConversation({
                            ticketId: ticket.id,
                            branch: branch?.ref ?? null,
                            ticketKey: ticket.key,
                          })}
                        >
                          Nouvelle conv.
                        </button>
                        {onCreateTodoFromTicket ? (
                          <button type="button" className="text-button" onClick={() => onCreateTodoFromTicket(ticket)}>
                            Créer une tâche
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className={`text-button dashboard-instruction-button${ticket.instruction ? ' is-active' : ''}`}
                          onClick={() => openInstruction(ticket)}
                        >
                          {ticket.instruction ? 'Instruction' : '+ Instruction'}
                        </button>
                      </span>
                  </div>
                )
              })}
            </div>
          )}
        </section>
        ) : null}

        {activeTab === 'sentry' ? (
          <div id="dashboard-panel-sentry" role="tabpanel" aria-labelledby={embedded ? 'project-section-sentry' : 'dashboard-tab-sentry'}>
            <SentryInbox projectId={project.id} onConfigure={onOpenSettings} onConversationSelect={onConversationSelect} />
          </div>
        ) : null}

        {activeTab === 'changelog' ? (
        <section id="dashboard-panel-changelog" role="tabpanel" aria-labelledby={embedded ? 'project-section-changelog' : 'dashboard-tab-changelog'} className="dashboard-section dashboard-changelog">
          <div className="dashboard-section-head">
            <div><h2 className="dashboard-section-title">Changelog</h2><p>{changelogTiming(changelogState, now)}</p></div>
            {changelogDomains.length > 1 ? <select aria-label="Filtrer le changelog par domaine" value={changelogDomain} onChange={(event) => setChangelogDomain(event.target.value)}><option value="">Tous les domaines</option>{changelogDomains.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select> : null}
          </div>
          {visibleChangelog.length === 0 ? <div className="dashboard-empty"><strong>Aucun commit importé</strong><p>Le premier passage reprendra automatiquement l’historique depuis le 1er janvier 2026.</p></div> : <ol className="dashboard-changelog-list">{visibleChangelog.slice(0, 100).map((item) => <li key={`${item.repository_path}:${item.commit_sha}`}><div><span className="dashboard-pill">{item.domain_name ?? 'À enrichir'}</span>{changelogHasMultipleRepositories ? <span className="dashboard-repository-label">{item.repository_path === '.' ? project.name : item.repository_path.split('/').at(-1)}</span> : null}<span className="dashboard-branch-label"><BranchIcon />{item.branch}</span><code>{item.commit_sha.slice(0, 7)}</code><time>{new Date(item.committed_at).toLocaleDateString('fr-FR')}</time></div><strong>{item.product_message ?? item.subject}</strong>{item.product_message ? <small>{item.subject}</small> : <small>Enrichissement en attente</small>}</li>)}</ol>}
        </section>
        ) : null}

        {activeTab === 'environments' ? (
          <section id="dashboard-panel-environments" role="tabpanel" aria-labelledby={embedded ? 'project-section-environments' : 'dashboard-tab-environments'} className="dashboard-section">
            <div className="dashboard-section-head">
              <h2 className="dashboard-section-title">Environnements</h2>
            </div>
            {data === null ? null : data.environments.length === 0 ? (
              <div className="dashboard-empty"><strong>Aucun environnement détecté</strong><p>Les derniers déploiements apparaîtront ici.</p></div>
            ) : <div className="dashboard-envs" role="region" aria-label="Environnements">
              <div className="dashboard-env-row dashboard-head">
                <span>Environnement</span>
                <span>Branche</span>
                <span>Par</span>
                <span>Depuis</span>
              </div>
              {data.environments.map((environment) => (
                <div className="dashboard-env-row" key={`${environment.project}:${environment.name}`}>
                  <span>
                    <small>{environment.project}</small>
                    {' '}
                    <strong>{environment.name}</strong>
                  </span>
                  <span className="dashboard-branch">
                    {environment.missing ? (
                      'introuvable'
                    ) : environment.branch ? (
                      <>
                        <BranchIcon />
                        <span>{environment.branch}</span>
                        {environment.key ? <small> · {environment.key}</small> : null}
                      </>
                    ) : (
                      '—'
                    )}
                  </span>
                  <span>{environment.user ?? '—'}</span>
                  <span>{relative(environment.deployedAt)}</span>
                </div>
              ))}
            </div>}
          </section>
        ) : null}

        {activeTab === 'tickets' && data && data.toReview.length > 0 ? (
          <section className="dashboard-section">
            <div className="dashboard-section-head">
              <h2 className="dashboard-section-title">À relire</h2>
            </div>
            <ul className="dashboard-review">
              {data.toReview.map((review) => (
                <li key={`${review.project}!${review.iid}`}>
                  <div className="dashboard-review-main">
                    <ExternalLink className="dashboard-card-link" href={review.url}>
                      <strong>{reviewLabel(review)}</strong>
                      <span>{review.title}</span>
                    </ExternalLink>
                    {review.draft ? <span className="dashboard-pill is-warn">draft</span> : null}
                  </div>
                  <small>{review.author} · {relative(review.updatedAt)}</small>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
      {instructionTicket ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setInstructionTicket(null)} onKeyDown={(event) => { if (event.key === 'Escape') setInstructionTicket(null) }}>
          <section className="modal review-dialog dashboard-instruction-dialog" role="dialog" aria-modal="true" aria-labelledby="ticket-instruction-title" onMouseDown={(event) => event.stopPropagation()}>
            <header className="modal-header">
              <div><h2 id="ticket-instruction-title">Instruction · {instructionTicket.key}</h2><p>Injectée dans chaque nouvelle conversation reliée à ce ticket.</p></div>
              <button type="button" className="modal-close" onClick={() => setInstructionTicket(null)} aria-label="Fermer">×</button>
            </header>
            <form className="review-dialog-form dashboard-instruction-form" onSubmit={(event) => { event.preventDefault(); void handleSaveInstruction() }}>
              <label htmlFor="ticket-instruction">Instruction</label>
              <textarea id="ticket-instruction" autoFocus rows={8} value={instructionDraft} onChange={(event) => setInstructionDraft(event.target.value)} placeholder="Ex. Vérifier la rétrocompatibilité de l’API avant toute modification…" />
              {instructionError ? <p className="modal-error" role="alert">{instructionError}</p> : null}
              <footer className="modal-actions"><button type="button" className="secondary-button" onClick={() => setInstructionTicket(null)}>Annuler</button><button type="submit" className="primary-button" disabled={instructionSaving}>{instructionSaving ? 'Enregistrement…' : 'Enregistrer'}</button></footer>
            </form>
          </section>
        </div>
      ) : null}
    </section>
  )
}
