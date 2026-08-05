import type {
  Conversation,
  ConversationSpeed,
  Debrief,
  GardienMode,
  GardienStatus,
  GitDiff,
  GitSnapshot,
  Project,
  Preset,
  Provider,
  QuotaSnapshot,
  Review,
  ReviewDecision,
  ReviewFlag,
  SkillDetail,
  SkillSummary,
  SkillSuggestionResult,
  StoredEvent,
  SubtaskResult,
  TestInventory,
  TestScope,
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
  orchestrator: boolean
  message: string
  images?: string[]
}

export interface SendMessageInput {
  message: string
  images?: string[]
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
  review_provider?: Provider
  review_model?: string
  review_effort?: string
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
  const response = await ensureOk(await fetch(httpUrl(input), init))
  return response.json() as Promise<T>
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

export function getSettings(signal?: AbortSignal): Promise<Settings> {
  return fetchJson('/api/settings', { signal })
}

export function updateSettings(settings: Settings): Promise<Settings> {
  return fetchJson('/api/settings', jsonPut(settings))
}

export function listProjectConversations(
  projectId: string,
): Promise<Conversation[]> {
  return fetchJson(`/api/projects/${routeId(projectId)}/conversations`)
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

export function uploadMedia(image: Blob): Promise<{ name: string }> {
  return fetchJson('/api/media', {
    method: 'POST',
    headers: { 'content-type': image.type || 'application/octet-stream' },
    body: image,
  })
}

export async function fetchMedia(name: string): Promise<Blob> {
  const response = await ensureOk(await fetch(httpUrl(`/media/${routeId(name)}`)))
  return response.blob()
}
