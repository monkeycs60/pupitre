export type Provider = 'claude' | 'codex'
export type ConversationSpeed = 'standard' | 'fast'

export interface Project {
  id: string
  name: string
  path: string
  permission_mode: string
  pinned: boolean
  created_at: string
}

export interface Conversation {
  id: string
  project_id: string
  title: string
  provider: Provider
  model: string
  effort: string | null
  speed: ConversationSpeed | null
  cli_session_id: string | null
  pinned: boolean
  created_at: string
  updated_at: string
}

export type AppEvent =
  | { type: 'session'; provider: Provider; cliSessionId: string; model: string }
  | { type: 'user-message'; text: string; images: string[] }
  | { type: 'text-delta'; text: string }
  | { type: 'text-final'; text: string }
  | { type: 'tool-start'; toolId: string; toolName: string; input: unknown }
  | { type: 'tool-end'; toolId: string; output: string; images: string[] }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'status'; state: 'running' | 'done' | 'error'; error?: string }

// Tout événement venant du sidecar (replay HTTP ou WS) porte l'id de sa ligne :
// c'est la clé de dédup du raccord replay/live.
export type StoredEvent = AppEvent & { id: number }
