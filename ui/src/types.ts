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
  orchestrator: boolean
  cli_session_id: string | null
  pinned: boolean
  created_at: string
  updated_at: string
}

// Miroir de sidecar/src/quotas.ts : forme normalisée des deux providers.
export interface QuotaWindow {
  label: string
  /** null = le provider ne publie pas de pourcentage pour cette fenêtre. */
  usedPercent: number | null
  /** Date ISO 8601 de remise à zéro, ou null si inconnue. */
  resetsAt: string | null
  windowDurationMins: number | null
}

export interface QuotaState {
  provider: Provider
  windows: QuotaWindow[]
  updatedAt: string
}

export interface QuotaSnapshot {
  claude: QuotaState | null
  codex: QuotaState | null
}

// Miroir de sidecar/src/subtasks.ts : une sous-tâche déléguée par une
// conversation à un autre modèle (le Conductor de la phase D).
export type SubtaskStatus = 'running' | 'done' | 'error'

export interface Subtask {
  id: string
  conversation_id: string
  provider: Provider
  model: string
  effort: string | null
  speed: ConversationSpeed | null
  prompt: string
  label: string | null
  status: SubtaskStatus
  created_at: string
  updated_at: string
}

export interface SubtaskResult {
  status: SubtaskStatus
  /** Concaténation des `text-final` de la sous-tâche. */
  resultText: string
  /**
   * Message du dernier événement terminal en erreur, null sinon. C'est la seule
   * source de la cause d'un échec pour une carte repliée (donc non abonnée).
   */
  error: string | null
  subtask: Subtask
}

export type AppEvent =
  | { type: 'session'; provider: Provider; cliSessionId: string; model: string }
  | { type: 'user-message'; text: string; images: string[] }
  | { type: 'text-delta'; text: string }
  | { type: 'text-final'; text: string }
  | { type: 'tool-start'; toolId: string; toolName: string; input: unknown }
  | { type: 'tool-end'; toolId: string; output: string; images: string[] }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  // Appendé à la conversation PARENTE au lancement d'une sous-tâche : l'UI en
  // fait une carte de sub-agent, dont le flux vit sous l'id de la sous-tâche.
  | {
      type: 'subtask-ref'
      subtaskId: string
      provider: Provider
      model: string
      label?: string
    }
  // Introspection de quota native du provider (payload brut, interprété côté
  // sidecar par le QuotaTracker — cf. sidecar/src/events.ts).
  | { type: 'rate-limit'; provider: Provider; payload: unknown }
  | { type: 'status'; state: 'running' | 'done' | 'error'; error?: string }

// Tout événement venant du sidecar (replay HTTP ou WS) porte l'id de sa ligne :
// c'est la clé de dédup du raccord replay/live.
export type StoredEvent = AppEvent & { id: number }
