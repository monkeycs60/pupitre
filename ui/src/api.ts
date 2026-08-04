import type { AppEvent, Conversation, Project, Provider } from './types'

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
  message: string
  images?: string[]
}

export interface SendMessageInput {
  message: string
  images?: string[]
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
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<T> {
  const response = await ensureOk(await fetch(input, init))
  return response.json() as Promise<T>
}

async function fetchVoid(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<void> {
  await ensureOk(await fetch(input, init))
}

function jsonPost(body: unknown): RequestInit {
  return {
    method: 'POST',
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

export function createProject(input: CreateProjectInput): Promise<Project> {
  return fetchJson('/api/projects', jsonPost(input))
}

export function setProjectPinned(id: string, pinned: boolean): Promise<void> {
  return fetchVoid(`/api/projects/${routeId(id)}/pin`, jsonPost({ pinned }))
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
): Promise<AppEvent[]> {
  return fetchJson(
    `/api/conversations/${routeId(conversationId)}/events`,
    { signal },
  )
}

export function uploadMedia(image: Blob): Promise<{ name: string }> {
  return fetchJson('/api/media', {
    method: 'POST',
    headers: { 'content-type': image.type || 'application/octet-stream' },
    body: image,
  })
}

export async function fetchMedia(name: string): Promise<Blob> {
  const response = await ensureOk(await fetch(`/media/${routeId(name)}`))
  return response.blob()
}
