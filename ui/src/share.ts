import { createConversation, ensureShareProject } from './api'
import { readLaunchConfig } from './configMemory'
import { PROVIDER_DEFAULTS } from './modelOptions'

export const SHARE_PATH = '/share'

const YOUTUBE_ID = /(?:youtube\.com\/(?:watch\?(?:[^#\s]*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([\w-]{11})(?![\w-])/

export interface ShareLaunch {
  youtubeUrl: string | null
}

export function readShareLaunch(location: Pick<Location, 'pathname' | 'search'>): ShareLaunch | null {
  if (location.pathname.replace(/\/+$/, '') !== SHARE_PATH) return null
  const params = new URLSearchParams(location.search)
  const shared = ['url', 'text', 'title'].map((key) => params.get(key) ?? '').join(' ')
  const id = shared.match(YOUTUBE_ID)?.[1]
  return { youtubeUrl: id ? `https://youtu.be/${id}` : null }
}

export function youtubeSharePrompt(youtubeUrl: string): string {
  return `$youtube ${youtubeUrl}`
}

export async function startYoutubeShare(youtubeUrl: string): Promise<{ projectId: string; conversationId: string }> {
  const project = await ensureShareProject()
  const remembered = readLaunchConfig(project.id)
  const conversation = await createConversation({
    projectId: project.id,
    presetId: remembered?.presetId ?? null,
    provider: remembered?.provider ?? 'claude',
    model: remembered?.model ?? PROVIDER_DEFAULTS.claude.model,
    effort: remembered?.effort ?? PROVIDER_DEFAULTS.claude.effort,
    speed: remembered?.speed,
    permissionMode: remembered?.permissionMode ?? null,
    message: youtubeSharePrompt(youtubeUrl),
  })
  return { projectId: project.id, conversationId: conversation.id }
}
