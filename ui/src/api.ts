import type { ActionFormat } from './actionHeadings'
import type {
  Conversation,
  ConversationSpeed,
  Debrief,
  GardienMode,
  GardienStatus,
  GitDiff,
  GitSnapshot,
  FleetItem,
  SearchResult,
  Project,
  ProjectCostReport,
  MemoryDocument,
  MemoryFile,
  Preset,
  PresetPermissionMode,
  Provider,
  QuotaSnapshot,
  Review,
  ReviewDecision,
  ReviewFlag,
  Routine,
  RoutineRun,
  AppNotification,
  SkillDetail,
  SkillSummary,
  SkillSuggestionResult,
  StoredEvent,
  SubtaskResult,
  TestInventory,
  TestScope,
  Workflow,
  Attachment,
  FilesystemScope,
  GamificationSnapshot,
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
  provider: Provider
  model: string
  effort?: string
  speed?: ConversationSpeed
  permissionMode?: PresetPermissionMode | null
  orchestrator: boolean
  subagentPresetId?: string | null
  subagentEffort?: string | null
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
  gitRefBase?: string
  gitRefHead?: string
  presetId?: string | null
  reviewProvider?: Provider
  reviewModel?: string
  reviewEffort?: string
  codeProvider?: Provider
}

export interface Settings {
  quotaThresholds?: QuotaThresholds
  longTaskThresholdSeconds?: number
  filesystemScope?: FilesystemScope
  actionFormat?: ActionFormat
  /** Lecture seule : calculé par le sidecar, ignoré en écriture. */
  conductorToolTokens?: number
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

export function getGamification(projectId?: string, signal?: AbortSignal): Promise<GamificationSnapshot> {
  const suffix = projectId ? `?projectId=${routeId(projectId)}` : ''
  return fetchJson(`/api/gamification${suffix}`, { signal })
}

export function addGamificationActivity(
  day: string,
  activeMs: number,
): Promise<void> {
  return fetchVoid('/api/gamification/activity', jsonPost({ day, activeMs }))
}

export function getFleet(signal?: AbortSignal): Promise<FleetItem[]> {
  return fetchJson('/api/fleet', { signal })
}

export function searchGlobal(
  query: string,
  projectId?: string,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: query })
  if (projectId) params.set('projectId', projectId)
  return fetchJson(`/api/search?${params.toString()}`, { signal })
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

export function suggestSkills(
  projectId: string,
  text: string,
  resolveAmbiguous: boolean,
  signal?: AbortSignal,
): Promise<SkillSuggestionResult> {
  return fetchJson('/api/skills/suggestions', {
    ...jsonPost({ projectId, text, resolveAmbiguous }),
    signal,
  })
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

export function setProjectFilesystemScope(
  id: string,
  scope: FilesystemScope,
): Promise<Project> {
  return fetchJson(
    `/api/projects/${routeId(id)}/filesystem-scope`,
    jsonPut({ scope }),
  )
}

export function setProjectGardienMode(
  id: string,
  mode: GardienMode,
): Promise<Project> {
  return fetchJson(`/api/projects/${routeId(id)}/gardien-mode`, jsonPut({ mode }))
}

export function setProjectAutoCounterRed(
  id: string,
  enabled: boolean,
): Promise<Project> {
  return fetchJson(`/api/projects/${routeId(id)}/auto-counter-red`, jsonPut({ enabled }))
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

export function createDebrief(conversationId: string): Promise<Debrief> {
  return fetchJson(
    `/api/conversations/${routeId(conversationId)}/debrief`,
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
  signal?: AbortSignal,
): Promise<GitSnapshot> {
  return fetchJson(`/api/projects/${routeId(projectId)}/git`, { signal })
}

export function getProjectGitDiff(
  projectId: string,
  base: string,
  head: string,
  signal?: AbortSignal,
): Promise<GitDiff> {
  const query = new URLSearchParams({ base, head })
  return fetchJson(
    `/api/projects/${routeId(projectId)}/git/diff?${query.toString()}`,
    { signal },
  )
}

export function getReview(reviewId: string, signal?: AbortSignal): Promise<Review> {
  return fetchJson(`/api/reviews/${routeId(reviewId)}`, { signal })
}

export function setReviewFlagStatus(
  flagId: string,
  status: 'open' | 'acked' | 'dismissed',
): Promise<ReviewFlag> {
  return fetchJson(`/api/review-flags/${routeId(flagId)}`, jsonPatch({ status }))
}

export function setReviewFlagCodeProvider(
  flagId: string,
  codeProvider: Provider,
): Promise<ReviewFlag> {
  return fetchJson(
    `/api/review-flags/${routeId(flagId)}`,
    jsonPatch({ codeProvider }),
  )
}

export function setReviewDecisionStatus(
  decisionId: string,
  status: 'acked' | 'dismissed',
): Promise<ReviewDecision> {
  return fetchJson(
    `/api/review-decisions/${routeId(decisionId)}`,
    jsonPatch({ status }),
  )
}

export function startFlagCounterOpinion(
  flagId: string,
  model: string,
  effort: string,
  codeProvider: Provider,
): Promise<ReviewFlag[]> {
  return fetchJson(
    `/api/review-flags/${routeId(flagId)}/counter-opinion`,
    jsonPost({ model, effort, codeProvider }),
  )
}

export function startReviewCounterOpinions(
  reviewId: string,
  model?: string,
  effort?: string,
): Promise<ReviewFlag[]> {
  return fetchJson(
    `/api/reviews/${routeId(reviewId)}/counter-opinions`,
    jsonPost(model && effort ? { model, effort } : {}),
  )
}

export function getGardienStatus(
  projectId: string,
  signal?: AbortSignal,
): Promise<GardienStatus> {
  return fetchJson(`/api/projects/${routeId(projectId)}/gardien-status`, { signal })
}

export function getSubtask(
  subtaskId: string,
  signal?: AbortSignal,
): Promise<SubtaskResult> {
  return fetchJson(`/api/subtasks/${routeId(subtaskId)}`, { signal })
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
