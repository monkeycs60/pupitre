import type { ActionFormat } from './actionHeadings'
import type {
  Conversation,
  ConversationSpeed,
  Debrief,
  DesignReachability,
  DashboardPayload,
  DashboardIntegration,
  GitDiff,
  GitCommitResult,
  GitPushCommit,
  GitSnapshot,
  FleetItem,
  IntegrationType,
  SearchResult,
  ProjectDomain,
  DomainKind,
  Project,
  ProjectIntegration,
  ProjectCostReport,
  MemoryDocument,
  MemoryFile,
  Preset,
  PresetPermissionMode,
  Provider,
  QuotaSnapshot,
  Review,
  ReviewFlag,
  ReviewFlagStatus,
  ReviewStatusSnapshot,
  Routine,
  RoutineRun,
  SessionSummary,
  ProjectChangelogPayload,
  ProjectChangelogState,
  AppNotification,
  SkillDetail,
  SkillSummary,
  StoredEvent,
  SubtaskResult,
  TicketNote,
  TestInventory,
  TestScope,
  Workflow,
  Attachment,
  FilesystemScope,
  TimeSnapshot,
  HtmlDocument,
  SentryInboxPayload,
  SentryIssue,
  Problem,
  ProblemCapture,
  ProblemProjectPayload,
} from './types'
import type { QuotaThresholds } from './quotaSignals'
import { httpUrl } from './transport'

interface ErrorResponse {
  error?: string
}

export interface CreateProjectInput {
  name: string
  path: string
}

export interface CreateConversationInput {
  projectId: string
  presetId?: string | null
  provider: Provider
  model: string
  effort?: string
  speed?: ConversationSpeed
  permissionMode?: PresetPermissionMode | null
  orchestrator: boolean
  subagentPresetId?: string | null
  subagentEffort?: string | null
  /** Fait naître la conversation sur cette branche, dans un worktree dédié. */
  branch?: string | null
  ticketId?: string | null
  originType?: 'sentry' | 'problem' | null
  originKey?: string | null
  problemPlanIndex?: number | null
  problemIds?: string[]
  problemPlanIndices?: Record<string, number[]>
  missionTitle?: string
  message: string
  images?: string[]
  attachments?: Attachment[]
}

export interface SendMessageInput {
  message: string
  images?: string[]
  attachments?: Attachment[]
}

export interface ModelConfigInput {
  provider: Provider
  model: string
  effort: string | null
  speed: ConversationSpeed | null
  orchestrator?: boolean
}

export interface PresetInput {
  name: string
  provider: Provider
  model: string
  effort: string | null
  speed: ConversationSpeed | null
  orchestrator: boolean
  subagent_preset_id?: string | null
  subagent_effort?: string | null
  permission_mode?: PresetPermissionMode | null
  review_provider?: Provider
  review_model?: string
  review_effort?: string
}

export interface WorkflowInput {
  projectId: string
  name: string
  skillId: string
  prompt: string
  presetId: string | null
  provider?: Provider
  model?: string
  effort?: string | null
  speed?: ConversationSpeed | null
  orchestrator?: boolean
}

export interface RoutineInput {
  projectId: string
  name: string
  schedule: string
  workflowId: string | null
  prompt: string | null
  presetId: string | null
  provider: Provider
  model: string
  effort: string | null
  speed: ConversationSpeed | null
  orchestrator: boolean
  enabled: boolean
}

export interface StartReviewInput {
  conversationId: string
  scope?: 'worktree' | 'comparison'
  gitRefBase?: string
  gitRefHead?: string
  incremental?: boolean
}

export interface Settings {
  quotaThresholds?: QuotaThresholds
  longTaskThresholdSeconds?: number
  filesystemScope?: FilesystemScope
  actionFormat?: ActionFormat
  integrationTokens?: Record<string, boolean>
  /** Lecture seule : calculé par le sidecar, ignoré en écriture. */
  conductorToolTokens?: number
  /** Contexte d'un tour à vide, mesuré par « Vérifier en réel ». */
  contextBaseline?: number
  /** Dernière page Claude Design visitée, pour rouvrir la vue dessus. `null`
   *  efface la reprise. Le sidecar refuse toute URL hors `claude.ai/design`. */
  designLastUrl?: string | null
}

export class ApiError extends Error {
  readonly status: number

  constructor(
    status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

// En développement, Vite peut répondre 502/503 pendant que Tauri compile puis
// démarre le sidecar. Les lectures initiales peuvent donc être rejouées sans
// risque ; les écritures restent volontairement en échec immédiat.
const READ_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 3_000, 3_000]

function isReadRequest(init?: RequestInit): boolean {
  const method = init?.method?.toUpperCase() ?? 'GET'
  return method === 'GET' || method === 'HEAD'
}

function isRetryableReadFailure(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.status === 502 || error.status === 503 || error.status === 504
  }
  return error instanceof TypeError
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

async function ensureOk(response: Response): Promise<Response> {
  if (response.ok) return response

  let message = `Erreur HTTP ${response.status}`
  try {
    const body = (await response.json()) as ErrorResponse
    if (body.error) message = body.error
  } catch {
    // La réponse d'erreur ne contient pas de JSON exploitable.
  }
  throw new ApiError(response.status, message)
}

async function fetchJson<T>(
  input: string,
  init?: RequestInit,
): Promise<T> {
  const retryRead = isReadRequest(init)
  let attempt = 0

  while (true) {
    try {
      const response = await ensureOk(await fetch(httpUrl(input), init))
      return response.json() as Promise<T>
    } catch (error) {
      const signalAborted = init?.signal?.aborted === true
      if (
        !retryRead
        || signalAborted
        || isAbortError(error)
        || !isRetryableReadFailure(error)
        || attempt >= READ_RETRY_DELAYS_MS.length
      ) {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, READ_RETRY_DELAYS_MS[attempt]))
      attempt += 1
    }
  }
}

async function fetchVoid(
  input: string,
  init?: RequestInit,
): Promise<void> {
  await ensureOk(await fetch(httpUrl(input), init))
}

function jsonPost(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

function jsonPut(body: unknown): RequestInit {
  return {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

function jsonPatch(body: unknown): RequestInit {
  return {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

function routeId(id: string): string {
  return encodeURIComponent(id)
}

export function getHealth(): Promise<{ ok: true }> {
  return fetchJson('/api/health')
}

export function getHtmlDocument(id: string, signal?: AbortSignal): Promise<HtmlDocument> {
  return fetchJson(`/api/documents/${routeId(id)}`, { signal })
}

export function listDocuments(filters: {
  projectId?: string
  query?: string
  kind?: 'html' | 'pdf'
  state?: 'active' | 'retained' | 'available'
} = {}, signal?: AbortSignal): Promise<HtmlDocument[]> {
  const params = new URLSearchParams()
  if (filters.projectId) params.set('projectId', filters.projectId)
  if (filters.query) params.set('q', filters.query)
  if (filters.kind) params.set('kind', filters.kind)
  if (filters.state) params.set('state', filters.state)
  const suffix = params.size > 0 ? `?${params.toString()}` : ''
  return fetchJson(`/api/documents${suffix}`, { signal })
}

export function createHtmlDocumentViewToken(
  id: string,
): Promise<{ token: string; expiresAt: string }> {
  return fetchJson(`/api/documents/${routeId(id)}/view-token`, jsonPost({}))
}

export function retainHtmlDocument(id: string): Promise<HtmlDocument> {
  return fetchJson(`/api/documents/${routeId(id)}/retain`, jsonPost({}))
}

export function deleteHtmlDocument(id: string): Promise<HtmlDocument> {
  return fetchJson(`/api/documents/${routeId(id)}`, { method: 'DELETE' })
}

export function exportDocument(id: string, path: string): Promise<{ path: string; sizeBytes: number }> {
  return fetchJson(`/api/documents/${routeId(id)}/export`, jsonPost({ path }))
}

export function getTimeSnapshot(
  projectId?: string,
  conversationId?: string,
  signal?: AbortSignal,
): Promise<TimeSnapshot> {
  const params = new URLSearchParams()
  if (projectId) params.set('projectId', projectId)
  if (conversationId) params.set('conversationId', conversationId)
  const suffix = params.size > 0 ? `?${params.toString()}` : ''
  return fetchJson(`/api/time${suffix}`, { signal })
}

export function addPresenceSlice(slice: {
  projectId: string
  conversationId?: string | null
  startedAt: string
  endedAt: string
}): Promise<void> {
  return fetchVoid('/api/time/presence', jsonPost(slice))
}

export function getFleet(signal?: AbortSignal): Promise<FleetItem[]> {
  return fetchJson('/api/fleet', { signal })
}

export function getDesignReachability(signal?: AbortSignal): Promise<DesignReachability> {
  return fetchJson('/api/design/reachability', { signal })
}

export function searchGlobal(
  query: string,
  projectId?: string,
  signal?: AbortSignal,
  domainId?: string,
): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: query })
  if (projectId) params.set('projectId', projectId)
  if (domainId) params.set('domainId', domainId)
  return fetchJson(`/api/search?${params.toString()}`, { signal })
}

export function listProjectDomains(projectId: string, signal?: AbortSignal): Promise<ProjectDomain[]> {
  return fetchJson(`/api/projects/${routeId(projectId)}/domains`, { signal })
}

export function createProjectDomain(
  projectId: string,
  input: { name: string; kind: DomainKind },
): Promise<ProjectDomain> {
  return fetchJson(`/api/projects/${routeId(projectId)}/domains`, jsonPost(input))
}

export function validateProjectDomain(projectId: string, domainId: string): Promise<ProjectDomain> {
  return fetchJson(`/api/projects/${routeId(projectId)}/domains/${routeId(domainId)}/validate`, jsonPost({}))
}

export function renameProjectDomain(
  projectId: string,
  domainId: string,
  input: { name?: string; kind?: DomainKind },
): Promise<ProjectDomain> {
  return fetchJson(`/api/projects/${routeId(projectId)}/domains/${routeId(domainId)}`, jsonPatch(input))
}

export function mergeProjectDomain(
  projectId: string,
  domainId: string,
  targetId: string,
): Promise<ProjectDomain> {
  return fetchJson(`/api/projects/${routeId(projectId)}/domains/${routeId(domainId)}/merge`, jsonPost({ targetId }))
}

export function deleteProjectDomain(projectId: string, domainId: string): Promise<void> {
  return fetchVoid(`/api/projects/${routeId(projectId)}/domains/${routeId(domainId)}`, { method: 'DELETE' })
}

export function associateConversationDomain(
  conversationId: string,
  domainId: string,
): Promise<Conversation> {
  return fetchJson(`/api/conversations/${routeId(conversationId)}/domains`, jsonPost({ domainId }))
}

export function dissociateConversationDomain(
  conversationId: string,
  domainId: string,
): Promise<Conversation> {
  return fetchJson(
    `/api/conversations/${routeId(conversationId)}/domains/${routeId(domainId)}`,
    { method: 'DELETE' },
  )
}

export function listMemory(): Promise<MemoryFile[]> {
  return fetchJson('/api/memory')
}

export function createMemory(path: string, content = ''): Promise<MemoryDocument> {
  return fetchJson('/api/memory', {
    ...jsonPost({ path, content }),
  })
}

export function getMemory(path: string, signal?: AbortSignal): Promise<MemoryDocument> {
  return fetchJson(`/api/memory/${routeId(path)}`, { signal })
}

export function updateMemory(path: string, content: string): Promise<MemoryDocument> {
  return fetchJson(`/api/memory/${routeId(path)}`, jsonPut({ content }))
}

export function renameMemory(path: string, newPath: string): Promise<MemoryDocument> {
  return fetchJson(`/api/memory/${routeId(path)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ newPath }),
  })
}

export function deleteMemory(path: string): Promise<void> {
  return fetchVoid(`/api/memory/${routeId(path)}`, { method: 'DELETE' })
}

export function listProjects(): Promise<Project[]> {
  return fetchJson('/api/projects')
}

export function listSkills(filters: {
  query?: string
  provider?: Provider
  projectId?: string
  favoriteProjectId?: string
  signal?: AbortSignal
} = {}): Promise<SkillSummary[]> {
  const query = new URLSearchParams()
  if (filters.query?.trim()) query.set('q', filters.query.trim())
  if (filters.provider) query.set('provider', filters.provider)
  if (filters.projectId) query.set('projectId', filters.projectId)
  if (filters.favoriteProjectId) query.set('favoriteProjectId', filters.favoriteProjectId)
  const suffix = query.size > 0 ? `?${query.toString()}` : ''
  return fetchJson(`/api/skills${suffix}`, { signal: filters.signal })
}

export function getSkill(
  skillId: string,
  projectId?: string,
  signal?: AbortSignal,
): Promise<SkillDetail> {
  const query = new URLSearchParams()
  if (projectId) query.set('projectId', projectId)
  const suffix = query.size > 0 ? `?${query.toString()}` : ''
  return fetchJson(`/api/skills/${routeId(skillId)}${suffix}`, { signal })
}

export function refreshSkills(): Promise<{ count: number }> {
  return fetchJson('/api/skills/refresh', jsonPost({}))
}

export function setSkillFavorite(
  projectId: string,
  skillId: string,
  favorite: boolean,
): Promise<void> {
  return fetchVoid(
    `/api/projects/${routeId(projectId)}/skills/${routeId(skillId)}/favorite`,
    jsonPut({ favorite }),
  )
}

export function composeSkill(input: {
  projectId: string
  description: string
  scope: 'project' | 'global'
}): Promise<SkillDetail> {
  return fetchJson('/api/skills/generate', jsonPost(input))
}

export function listProjectWorkflows(projectId: string): Promise<Workflow[]> {
  return fetchJson(`/api/projects/${routeId(projectId)}/workflows`)
}

export function createWorkflow(input: WorkflowInput): Promise<Workflow> {
  return fetchJson('/api/workflows', jsonPost(input))
}

export function updateWorkflow(id: string, input: WorkflowInput): Promise<Workflow> {
  return fetchJson(`/api/workflows/${routeId(id)}`, jsonPut(input))
}

export function deleteWorkflow(id: string): Promise<void> {
  return fetchVoid(`/api/workflows/${routeId(id)}`, { method: 'DELETE' })
}

export function runWorkflow(id: string): Promise<Conversation> {
  return fetchJson(`/api/workflows/${routeId(id)}/run`, jsonPost({}))
}

export function listRoutines(projectId?: string): Promise<Routine[]> {
  const suffix = projectId ? `?projectId=${routeId(projectId)}` : ''
  return fetchJson(`/api/routines${suffix}`)
}

export function createRoutine(input: RoutineInput): Promise<Routine> {
  return fetchJson('/api/routines', jsonPost(input))
}

export function updateRoutine(id: string, input: RoutineInput): Promise<Routine> {
  return fetchJson(`/api/routines/${routeId(id)}`, jsonPut(input))
}

export function deleteRoutine(id: string): Promise<void> {
  return fetchVoid(`/api/routines/${routeId(id)}`, { method: 'DELETE' })
}

export function listRoutineRuns(id: string): Promise<RoutineRun[]> {
  return fetchJson(`/api/routines/${routeId(id)}/runs`)
}

export function runRoutine(id: string): Promise<RoutineRun> {
  return fetchJson(`/api/routines/${routeId(id)}/run`, jsonPost({}))
}

export function listNotifications(after = 0): Promise<AppNotification[]> {
  return fetchJson(`/api/notifications?after=${after}`)
}

export function getNotificationCursor(): Promise<{ cursor: number }> {
  return fetchJson('/api/notifications/cursor')
}

export function createProject(input: CreateProjectInput): Promise<Project> {
  return fetchJson('/api/projects', jsonPost(input))
}

export function setProjectPinned(id: string, pinned: boolean): Promise<void> {
  return fetchVoid(`/api/projects/${routeId(id)}/pin`, jsonPost({ pinned }))
}

export function setProjectDefaultPreset(
  id: string,
  presetId: string | null,
): Promise<Project> {
  return fetchJson(
    `/api/projects/${routeId(id)}/default-preset`,
    jsonPut({ presetId }),
  )
}

export function setProjectDefaultReviewPreset(
  id: string,
  presetId: string | null,
): Promise<Project> {
  return fetchJson(
    `/api/projects/${routeId(id)}/default-review-preset`,
    jsonPut({ presetId }),
  )
}

export function setProjectDefaultCorrectionPreset(
  id: string,
  presetId: string | null,
): Promise<Project> {
  return fetchJson(
    `/api/projects/${routeId(id)}/default-correction-preset`,
    jsonPut({ presetId }),
  )
}

export function setProjectDefaultScoutPreset(id: string, presetId: string | null): Promise<Project> {
  return fetchJson(`/api/projects/${routeId(id)}/default-scout-preset`, jsonPut({ presetId }))
}

export function setProjectFilesystemScope(
  id: string,
  scope: FilesystemScope,
): Promise<Project> {
  return fetchJson(
    `/api/projects/${routeId(id)}/filesystem-scope`,
    jsonPut({ scope }),
  )
}

export function setProjectPermissionMode(
  id: string,
  permissionMode: PresetPermissionMode,
): Promise<Project> {
  return fetchJson(
    `/api/projects/${routeId(id)}/permission-mode`,
    jsonPut({ permission_mode: permissionMode }),
  )
}

export function setProjectAutoRescan(
  id: string,
  enabled: boolean,
): Promise<Project> {
  return fetchJson(`/api/projects/${routeId(id)}/auto-rescan`, jsonPut({ enabled }))
}

export function listPresets(signal?: AbortSignal): Promise<Preset[]> {
  return fetchJson('/api/presets', { signal })
}

export function createPreset(input: PresetInput): Promise<Preset> {
  return fetchJson('/api/presets', jsonPost(input))
}

export function updatePreset(id: string, input: PresetInput): Promise<Preset> {
  return fetchJson(`/api/presets/${routeId(id)}`, jsonPut(input))
}

export function deletePreset(id: string): Promise<void> {
  return fetchVoid(`/api/presets/${routeId(id)}`, { method: 'DELETE' })
}

/** Remet un preset intégré à sa configuration d'usine. */
export function restorePreset(id: string): Promise<Preset> {
  return fetchJson(`/api/presets/${routeId(id)}/restore`, { method: 'POST' })
}

/**
 * Relève forcée des quotas. Côté codex c'est une lecture, côté claude un tour
 * minimal : c'est pour ça que l'appel est explicite et jamais périodique.
 */
export function refreshQuotas(): Promise<QuotaSnapshot> {
  return fetchJson('/api/quotas/refresh', { method: 'POST' })
}

export function authenticateQuotaProvider(provider: Provider): Promise<QuotaSnapshot> {
  return fetchJson('/api/quotas/auth', jsonPost({ provider }))
}

export interface McpServerRef {
  name: string
  provider: Provider
  scope: 'global' | 'projet'
}

export interface McpServerWeight {
  name: string
  /** Tokens des définitions d'outils, `null` si la mesure a échoué. */
  tokens: number | null
  toolCount: number
  error?: string
}

export interface ContextProfile {
  /** CLAUDE.md, AGENTS.md et fichiers mémoire, global et projet. */
  instructionsTokens: number
  /** Somme mesurée des serveurs MCP effectivement chargés. */
  mcpTokens: number
}

export function getProjectContextProfile(
  projectId: string,
  signal?: AbortSignal,
): Promise<ContextProfile> {
  return fetchJson(`/api/projects/${routeId(projectId)}/context-profile`, { signal })
}

export interface ProjectMcpConfig {
  servers: McpServerRef[]
  /** `null` = aucun filtre, tous les serveurs configurés sont chargés. */
  enabled: string[] | null
  /** Dernière mesure connue, par nom de serveur. */
  weights: Record<string, McpServerWeight>
  /** Serveurs réellement appelés dans l'historique du projet. */
  used: string[]
}

export interface McpContextProbe {
  withServers: number
  without: number
  /** Coût réel de la sélection, mesuré par deux tours CLI. */
  cost: number
  error?: string
}

/** Vérité terrain : deux tours CLI minimaux, avec et sans les serveurs. */
export function verifyProjectMcpCost(projectId: string): Promise<McpContextProbe> {
  return fetchJson(`/api/projects/${routeId(projectId)}/mcp-servers/verify`, { method: 'POST' })
}

/** Relance la mesure : lance chaque serveur et pèse ses définitions d'outils. */
export function measureProjectMcpServers(projectId: string): Promise<McpServerWeight[]> {
  return fetchJson(`/api/projects/${routeId(projectId)}/mcp-servers/measure`, { method: 'POST' })
}

/** Serveurs MCP configurés par l'utilisateur — noms seulement, jamais les clés. */
export function listProjectMcpServers(
  projectId: string,
  signal?: AbortSignal,
): Promise<ProjectMcpConfig> {
  return fetchJson(`/api/projects/${routeId(projectId)}/mcp-servers`, { signal })
}

export function updateProjectMcpServers(
  projectId: string,
  enabled: string[] | null,
): Promise<ProjectMcpConfig> {
  return fetchJson(`/api/projects/${routeId(projectId)}/mcp-servers`, jsonPut({ enabled }))
}

export function getSettings(signal?: AbortSignal): Promise<Settings> {
  return fetchJson('/api/settings', { signal })
}

export function updateSettings(settings: Settings): Promise<Settings> {
  return fetchJson('/api/settings', jsonPut(settings))
}

export function getProjectDashboard(
  projectId: string,
  signal?: AbortSignal,
): Promise<DashboardPayload> {
  return fetchJson(`/api/projects/${routeId(projectId)}/dashboard`, { signal })
}

export function refreshProjectDashboard(projectId: string): Promise<void> {
  return fetchVoid(`/api/projects/${routeId(projectId)}/dashboard/refresh`, jsonPost({}))
}

export function createProblemCapture(projectId: string, text: string): Promise<ProblemCapture> {
  return fetchJson(`/api/projects/${routeId(projectId)}/problem-captures`, jsonPost({ text }))
}

export function listProjectProblems(
  projectId: string,
  status: 'open' | 'closed' | 'all' = 'open',
  signal?: AbortSignal,
): Promise<ProblemProjectPayload> {
  return fetchJson(`/api/projects/${routeId(projectId)}/problems?status=${status}`, { signal })
}

export function retryProblemCapture(captureId: string): Promise<ProblemCapture> {
  return fetchJson(`/api/problem-captures/${routeId(captureId)}/retry`, jsonPost({}))
}

export function updateProblemTicket(problemId: string, ticketId: string | null): Promise<Problem> {
  return fetchJson(`/api/problems/${routeId(problemId)}/ticket`, jsonPut({ ticketId }))
}

export function closeProblem(problemId: string): Promise<Problem> {
  return fetchJson(`/api/problems/${routeId(problemId)}/close`, jsonPost({}))
}

export function reopenProblem(problemId: string): Promise<Problem> {
  return fetchJson(`/api/problems/${routeId(problemId)}/reopen`, jsonPost({}))
}

export function deleteProblem(problemId: string): Promise<void> {
  return fetchVoid(`/api/problems/${routeId(problemId)}`, { method: 'DELETE' })
}

export function getSentryInbox(projectId: string, signal?: AbortSignal): Promise<SentryInboxPayload> {
  return fetchJson(`/api/projects/${routeId(projectId)}/sentry`, { signal })
}

export function refreshSentryInbox(projectId: string): Promise<SentryInboxPayload> {
  return fetchJson(`/api/projects/${routeId(projectId)}/sentry/refresh`, jsonPost({}))
}

export function getSentryIssue(issueId: string, signal?: AbortSignal): Promise<SentryIssue> {
  return fetchJson(`/api/sentry/issues/${routeId(issueId)}`, { signal })
}

export function startSentryScout(issueId: string): Promise<Conversation> {
  return fetchJson(`/api/sentry/issues/${routeId(issueId)}/scout`, jsonPost({}))
}

export function createSentryFix(issueId: string): Promise<Conversation> {
  return fetchJson(`/api/sentry/issues/${routeId(issueId)}/create-fix`, jsonPost({ confirmed: true }))
}

export function listProjectIntegrations(
  projectId: string,
  signal?: AbortSignal,
): Promise<DashboardIntegration[]> {
  return fetchJson(`/api/projects/${routeId(projectId)}/integrations`, { signal })
}

export function saveProjectIntegration(
  projectId: string,
  type: IntegrationType,
  input: { config: Record<string, unknown>; branchPattern?: string | null; token?: string | null },
): Promise<ProjectIntegration> {
  return fetchJson(`/api/projects/${routeId(projectId)}/integrations/${type}`, jsonPut(input))
}

export function setAppVisibility(active: boolean): Promise<void> {
  return fetchVoid('/api/activity/visibility', jsonPost({ active }))
}

export function deleteProjectIntegration(
  projectId: string,
  type: IntegrationType,
): Promise<void> {
  return fetchVoid(`/api/projects/${routeId(projectId)}/integrations/${type}`, { method: 'DELETE' })
}

export function listTicketNotes(ticketId: string): Promise<TicketNote[]> {
  return fetchJson(`/api/tickets/${routeId(ticketId)}/notes`)
}

export function createTicketNote(ticketId: string, body: string): Promise<TicketNote> {
  return fetchJson(`/api/tickets/${routeId(ticketId)}/notes`, jsonPost({ body }))
}

export function deleteTicketNote(noteId: string): Promise<void> {
  return fetchVoid(`/api/ticket-notes/${routeId(noteId)}`, { method: 'DELETE' })
}

export function updateTicketInstruction(ticketId: string, instruction: string): Promise<void> {
  return fetchVoid(
    `/api/tickets/${routeId(ticketId)}/instruction`,
    { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instruction }) },
  )
}

export function updateIntegrationTokens(
  tokens: Partial<Record<'clickup' | 'gitlab', string | null>>,
): Promise<Settings> {
  return fetchJson('/api/settings', jsonPut({ integrationTokens: tokens }))
}

export function setConversationPermissionMode(
  id: string,
  permissionMode: PresetPermissionMode | null,
): Promise<Conversation> {
  return fetchJson(
    `/api/conversations/${routeId(id)}/permission-mode`,
    jsonPut({ permission_mode: permissionMode }),
  )
}

export function listProjectConversations(
  projectId: string,
  scope: 'active' | 'archived' | 'trash' = 'active',
): Promise<Conversation[]> {
  return fetchJson(`/api/projects/${routeId(projectId)}/conversations?scope=${scope}`)
}

export function getUnreadConversationCounts(): Promise<Record<string, number>> {
  return fetchJson('/api/conversations/unread-counts')
}

export function getProjectCosts(
  projectId: string,
  month: string,
  signal?: AbortSignal,
): Promise<ProjectCostReport> {
  return fetchJson(`/api/projects/${routeId(projectId)}/costs?month=${encodeURIComponent(month)}`, { signal })
}

export function createConversation(
  input: CreateConversationInput,
): Promise<Conversation> {
  return fetchJson('/api/conversations', jsonPost(input))
}

export function sendMessage(
  conversationId: string,
  input: SendMessageInput,
): Promise<void> {
  return fetchVoid(
    `/api/conversations/${routeId(conversationId)}/messages`,
    jsonPost(input),
  )
}

export function switchConversationModel(
  conversationId: string,
  input: ModelConfigInput,
): Promise<{ conversation: Conversation; estimatedReingestionTokens: number }> {
  return fetchJson(
    `/api/conversations/${routeId(conversationId)}/model`,
    jsonPut(input),
  )
}

export function handoffConversation(
  conversationId: string,
  input: ModelConfigInput,
): Promise<Conversation> {
  return fetchJson(
    `/api/conversations/${routeId(conversationId)}/handoff`,
    jsonPost(input),
  )
}

export function createHandoffConversation(
  conversationId: string,
  input: ModelConfigInput,
): Promise<Conversation> {
  return fetchJson(
    `/api/conversations/${routeId(conversationId)}/handoff-conversation`,
    jsonPost(input),
  )
}

export function createDebrief(conversationId: string): Promise<Debrief> {
  return fetchJson(
    `/api/conversations/${routeId(conversationId)}/debrief`,
    jsonPost({}),
  )
}

export function createSessionSummary(conversationId: string): Promise<SessionSummary> {
  return fetchJson(
    `/api/conversations/${routeId(conversationId)}/session-summary`,
    jsonPost({}),
  )
}

export function listProjectChangelog(projectId: string, domainId?: string): Promise<ProjectChangelogPayload> {
  const query = domainId ? `?domainId=${encodeURIComponent(domainId)}` : ''
  return fetchJson(`/api/projects/${routeId(projectId)}/changelog${query}`)
}

export function refreshProjectChangelog(projectId: string): Promise<ProjectChangelogState> {
  return fetchJson(`/api/projects/${routeId(projectId)}/changelog/refresh`, jsonPost({}))
}

export interface HandoffDocument {
  debriefId: string
  filename: string
  contentMd: string
  createdAt: string
}

export interface DiscussionDocument {
  filename: string
  contentMd: string
  createdAt: string
}

export function getDiscussionDocument(conversationId: string): Promise<DiscussionDocument> {
  return fetchJson(`/api/conversations/${routeId(conversationId)}/discussion-document`)
}

export function createHandoffDocument(conversationId: string): Promise<HandoffDocument> {
  return fetchJson(
    `/api/conversations/${routeId(conversationId)}/handoff-document`,
    jsonPost({}),
  )
}

export function createTestInventory(conversationId: string): Promise<TestInventory> {
  return fetchJson(
    `/api/conversations/${routeId(conversationId)}/test-inventory`,
    jsonPost({}),
  )
}

export function runTestScope(scopeId: string): Promise<TestScope> {
  return fetchJson(`/api/test-scopes/${routeId(scopeId)}/run`, jsonPost({}))
}

export function listDebriefs(conversationId: string): Promise<Debrief[]> {
  return fetchJson(`/api/conversations/${routeId(conversationId)}/debriefs`)
}

export function getDebrief(debriefId: string): Promise<Debrief> {
  return fetchJson(`/api/debriefs/${routeId(debriefId)}`)
}

export function cancelConversation(conversationId: string): Promise<void> {
  return fetchVoid(
    `/api/conversations/${routeId(conversationId)}/cancel`,
    jsonPost({}),
  )
}

export function setConversationPinned(
  conversationId: string,
  pinned: boolean,
): Promise<void> {
  return fetchVoid(
    `/api/conversations/${routeId(conversationId)}/pin`,
    jsonPost({ pinned }),
  )
}

/** Sans `lastReadTurn`, le sidecar marque lu jusqu'au digest courant. */
export function markConversationRead(
  conversationId: string,
  lastReadTurn?: number,
): Promise<Conversation> {
  return fetchJson(
    `/api/conversations/${routeId(conversationId)}/read`,
    jsonPost({ lastReadTurn: lastReadTurn ?? null }),
  )
}

export function renameConversation(
  conversationId: string,
  title: string,
): Promise<Conversation> {
  return fetchJson(
    `/api/conversations/${routeId(conversationId)}/rename`,
    jsonPost({ title }),
  )
}

export function setConversationArchived(
  conversationId: string,
  archived: boolean,
): Promise<Conversation> {
  return fetchJson(
    `/api/conversations/${routeId(conversationId)}/archive`,
    jsonPost({ archived }),
  )
}

export function purgeTrashedConversations(): Promise<{ purged: number }> {
  return fetchJson('/api/conversations/trash/purge', jsonPost({}))
}

export function setConversationDeleted(
  conversationId: string,
  deleted: boolean,
): Promise<Conversation> {
  return fetchJson(
    `/api/conversations/${routeId(conversationId)}/trash`,
    jsonPost({ deleted }),
  )
}

export function getConversationEvents(
  conversationId: string,
  signal?: AbortSignal,
): Promise<StoredEvent[]> {
  return fetchJson(
    `/api/conversations/${routeId(conversationId)}/events`,
    { signal },
  )
}

export interface EventPage {
  events: StoredEvent[]
  nextBefore: number | null
}

export async function getConversationEventPage(
  conversationId: string,
  before: number | null,
  signal?: AbortSignal,
): Promise<EventPage> {
  const cursor = before === null ? '' : `&before=${before}`
  const page = await fetchJson<EventPage | StoredEvent[]>(
    `/api/conversations/${routeId(conversationId)}/events?limit=400${cursor}`,
    { signal },
  )
  return Array.isArray(page) ? { events: page, nextBefore: null } : page
}

/** Le diff exact que lit le Gardien pour scanner cette conversation. */
export function getConversationDiff(
  conversationId: string,
  signal?: AbortSignal,
): Promise<GitDiff> {
  return fetchJson(`/api/conversations/${routeId(conversationId)}/diff`, { signal })
}

export function listConversationPushes(conversationId: string, signal?: AbortSignal): Promise<GitPushCommit[]> {
  return fetchJson(`/api/conversations/${routeId(conversationId)}/pushes`, { signal })
}

export function acknowledgeConversationPush(conversationId: string, sha: string): Promise<{ ok: true }> {
  return fetchJson(`/api/conversations/${routeId(conversationId)}/pushes/${routeId(sha)}/ack`, jsonPost({}))
}

export function startReview(input: StartReviewInput): Promise<Review> {
  return fetchJson('/api/reviews', jsonPost(input))
}

export function listProjectReviews(
  projectId: string,
  signal?: AbortSignal,
): Promise<Review[]> {
  return fetchJson(`/api/projects/${routeId(projectId)}/reviews`, { signal })
}

export function getProjectGit(
  projectId: string,
  conversationId?: string | null,
  signal?: AbortSignal,
): Promise<GitSnapshot> {
  const query = conversationId ? `?${new URLSearchParams({ conversationId })}` : ''
  return fetchJson(`/api/projects/${routeId(projectId)}/git${query}`, { signal })
}

export function getProjectGitDiff(
  projectId: string,
  base: string,
  head: string,
  conversationId?: string | null,
  signal?: AbortSignal,
): Promise<GitDiff> {
  const query = new URLSearchParams({ base, head })
  if (conversationId) query.set('conversationId', conversationId)
  return fetchJson(
    `/api/projects/${routeId(projectId)}/git/diff?${query.toString()}`,
    { signal },
  )
}

export function commitProjectGit(
  projectId: string,
  input: { conversationId: string, paths: string[], message: string },
): Promise<GitCommitResult> {
  return fetchJson(
    `/api/projects/${routeId(projectId)}/git/commit`,
    jsonPost(input),
  )
}

export function getReview(reviewId: string, signal?: AbortSignal): Promise<Review> {
  return fetchJson(`/api/reviews/${routeId(reviewId)}`, { signal })
}

export function setReviewFlagStatus(
  flagId: string,
  status: Extract<ReviewFlagStatus, 'open' | 'treated' | 'ignored'>,
): Promise<ReviewFlag> {
  return fetchJson(`/api/review-flags/${routeId(flagId)}`, jsonPatch({ status }))
}

export function getReviewStatus(
  projectId: string,
  signal?: AbortSignal,
): Promise<ReviewStatusSnapshot> {
  return fetchJson(`/api/projects/${routeId(projectId)}/review-status`, { signal })
}

export function dispatchFlag(flagId: string, message?: string): Promise<{ subtaskId: string }> {
  return fetchJson(`/api/review-flags/${routeId(flagId)}/dispatch`, jsonPost({ message }))
}

// Un serveur plus ancien ne renvoie que `dispatched` : sans liste, on n'invente
// aucun identifiant — l'appel a réussi, c'est le rafraîchissement qui dira quels
// signalements sont partis.
function dispatchedFlagIds(payload: { flagIds?: unknown }): string[] {
  return Array.isArray(payload.flagIds) ? payload.flagIds.filter((id) => typeof id === 'string') : []
}

export async function dispatchAllFlags(
  reviewId: string,
  severities: Array<'red' | 'orange' | 'grey'> = ['red', 'orange'],
): Promise<{ dispatched: number, flagIds: string[] }> {
  const payload = await fetchJson<{ dispatched: number, flagIds?: unknown }>(
    `/api/reviews/${routeId(reviewId)}/dispatch-all`,
    jsonPost({ severities }),
  )
  return { dispatched: payload.dispatched, flagIds: dispatchedFlagIds(payload) }
}

export async function dispatchGroupedFlags(
  reviewId: string,
  severities: Array<'red' | 'orange' | 'grey'> = ['red', 'orange'],
): Promise<{ subtaskId: string, dispatched: number, flagIds: string[] }> {
  const payload = await fetchJson<{ subtaskId: string, dispatched: number, flagIds?: unknown }>(
    `/api/reviews/${routeId(reviewId)}/dispatch-grouped`,
    jsonPost({ severities }),
  )
  return { subtaskId: payload.subtaskId, dispatched: payload.dispatched, flagIds: dispatchedFlagIds(payload) }
}

interface PendingSubtaskRequest {
  id: string
  signal?: AbortSignal
  resolve: (result: SubtaskResult) => void
  reject: (error: unknown) => void
}

let pendingSubtasks: PendingSubtaskRequest[] = []
let subtaskBatchScheduled = false

function flushSubtaskBatch(): void {
  subtaskBatchScheduled = false
  const pending = pendingSubtasks
  pendingSubtasks = []
  const active = pending.filter((request) => !request.signal?.aborted)
  for (const request of pending) {
    if (request.signal?.aborted) request.reject(new DOMException('Aborted', 'AbortError'))
  }
  if (active.length === 0) return
  const ids = [...new Set(active.map((request) => request.id))]
  void fetchJson<Record<string, SubtaskResult>>(
    `/api/subtasks/batch?ids=${ids.map(routeId).join(',')}`,
  ).then((results) => {
    for (const request of active) {
      const result = results[request.id]
      if (result) request.resolve(result)
      else request.reject(new ApiError(404, 'sous-tâche inconnue'))
    }
  }).catch((error: unknown) => {
    for (const request of active) request.reject(error)
  })
}

export function getSubtask(
  subtaskId: string,
  signal?: AbortSignal,
): Promise<SubtaskResult> {
  return new Promise((resolve, reject) => {
    pendingSubtasks.push({ id: subtaskId, signal, resolve, reject })
    if (!subtaskBatchScheduled) {
      subtaskBatchScheduled = true
      queueMicrotask(flushSubtaskBatch)
    }
  })
}

// Les events d'une sous-tâche vivent dans la même table que ceux d'une
// conversation, mais sous une route distincte : `/api/conversations/:id/events`
// refuse un id de sous-tâche.
export function getSubtaskEvents(
  subtaskId: string,
  signal?: AbortSignal,
): Promise<StoredEvent[]> {
  return fetchJson(`/api/subtasks/${routeId(subtaskId)}/events`, { signal })
}

export async function getSubtaskEventPage(
  subtaskId: string,
  before: number | null,
  signal?: AbortSignal,
): Promise<EventPage> {
  const cursor = before === null ? '' : `&before=${before}`
  const page = await fetchJson<EventPage | StoredEvent[]>(
    `/api/subtasks/${routeId(subtaskId)}/events?limit=400${cursor}`,
    { signal },
  )
  return Array.isArray(page) ? { events: page, nextBefore: null } : page
}

export function cancelSubtask(subtaskId: string): Promise<void> {
  return fetchVoid(`/api/subtasks/${routeId(subtaskId)}/cancel`, jsonPost({}))
}

export function getQuotas(signal?: AbortSignal): Promise<QuotaSnapshot> {
  return fetchJson('/api/quotas', { signal })
}

export function uploadMedia(file: Blob, originalName = ''): Promise<Attachment> {
  const headers: Record<string, string> = {
    'content-type': file.type || 'application/octet-stream',
  }
  if (originalName) headers['x-file-name'] = encodeURIComponent(originalName)
  return fetchJson('/api/media', {
    method: 'POST',
    headers,
    body: file,
  })
}

export function importMediaPath(path: string): Promise<Attachment> {
  return fetchJson('/api/media/import', jsonPost({ path }))
}

export async function fetchMedia(name: string): Promise<Blob> {
  const response = await ensureOk(await fetch(httpUrl(`/media/${routeId(name)}`)))
  return response.blob()
}
