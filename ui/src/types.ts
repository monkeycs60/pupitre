export type Provider = 'claude' | 'codex'
export type ConversationSpeed = 'standard' | 'fast'
export type GardienMode = 'informatif' | 'bloquant'

export interface Project {
  id: string
  name: string
  path: string
  permission_mode: string
  pinned: boolean
  created_at: string
  default_preset_id: string | null
  gardien_mode: GardienMode
  auto_counter_red: boolean
}

export interface Preset {
  id: string
  name: string
  provider: Provider
  model: string
  effort: string | null
  speed: ConversationSpeed | null
  orchestrator: boolean
  review_provider: Provider
  review_model: string
  review_effort: string
  built_in: boolean
  created_at: string
  updated_at: string
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
  continued_from: string | null
  cli_session_id: string | null
  pinned: boolean
  created_at: string
  updated_at: string
}

export interface Debrief {
  id: string
  conversation_id: string
  event_id_from: number
  event_id_to: number
  content_md: string
  created_at: string
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

export type ReviewStatus = 'running' | 'done' | 'error'
export type ReviewSeverity = 'red' | 'orange' | 'grey'
export type ReviewFlagStatus = 'open' | 'acked' | 'dismissed' | 'countered'
export type CounterState = 'idle' | 'queued' | 'running' | 'done' | 'error'
export type CounterVerdict = 'confirmed' | 'dismissed' | 'nuanced'

export interface ReviewFlag {
  id: string
  review_id: string
  file: string
  line_start: number
  line_end: number
  severity: ReviewSeverity
  category: string
  message: string
  test_gap?: boolean
  decision?: string
  status: ReviewFlagStatus
  code_provider: Provider
  counter_state: CounterState
  counter_verdict: CounterVerdict | null
  counter_text: string | null
  counter_provider: Provider | null
  counter_model: string | null
  counter_effort: string | null
  counter_subtask_id: string | null
  counter_error: string | null
}

export interface ReviewDecision {
  id: string
  review_id: string
  question: string
  flag_ids: string[]
  status: 'open' | 'acked' | 'dismissed'
}

export interface Review {
  id: string
  project_id: string
  conversation_id: string
  git_ref_base: string
  git_ref_head: string
  status: ReviewStatus
  review_provider: Provider
  review_model: string
  review_effort: string
  diff_text: string
  error: string | null
  created_at: string
  updated_at: string
  flags: ReviewFlag[]
  code_provider: Provider
  decisions: ReviewDecision[]
}

export interface GardienStatus {
  mode: GardienMode
  blocked: boolean
  openRedCount: number
  openFlagCount: number
  pendingReviewCount: number
}

export interface GitGuardianReview {
  reviewId: string
  red: number
  orange: number
  grey: number
}

export interface GitCommit {
  sha: string
  parents: string[]
  refs: string[]
  author: string
  authoredAt: string
  subject: string
  conversations: Array<{ id: string; title: string }>
  guardian: GitGuardianReview[]
}

export interface GitBranch {
  name: string
  fullName: string
  sha: string
  current: boolean
  remote: boolean
}

export interface GitWorktree {
  path: string
  head: string | null
  branch: string | null
  detached: boolean
  bare: boolean
}

export interface GitSnapshot {
  head: string | null
  headParents: string[]
  currentBranch: string | null
  commits: GitCommit[]
  branches: GitBranch[]
  worktrees: GitWorktree[]
}

export interface GitDiff {
  base: string
  head: string
  diff: string
}

export type TestScopeStatus = 'pending' | 'running' | 'passed' | 'failed'

export interface TestMethod {
  kind: 'unit' | 'browser' | 'manual'
  label: string
  instructions: string
}

export interface TestScope {
  id: string
  inventory_id?: string
  title: string
  description: string
  methods: TestMethod[]
  guardian_flag_ids?: string[]
  guardianFlagIds?: string[]
  status: TestScopeStatus
  subtask_id?: string | null
  subtaskId?: string | null
  evidence_md?: string | null
  evidenceMd?: string | null
  images: string[]
  guardianFlagIdsAcked?: string[]
  error: string | null
}

export interface TestInventory {
  id: string
  conversation_id: string
  event_id_from: number
  event_id_to: number
  created_at: string
  scopes: TestScope[]
}

export type AppEvent =
  | { type: 'session'; provider: Provider; cliSessionId: string; model: string }
  | { type: 'user-message'; text: string; images: string[] }
  | { type: 'text-delta'; text: string }
  | { type: 'text-final'; text: string }
  | { type: 'tool-start'; toolId: string; toolName: string; input: unknown }
  | { type: 'tool-end'; toolId: string; output: string; images: string[] }
  | {
      type: 'turn-timing'
      phase: 'started' | 'first-response' | 'completed'
      startedAt: string
      firstResponseAt?: string
      completedAt?: string
    }
  | {
      type: 'usage'
      inputTokens: number
      outputTokens: number
      contextTokens?: number
      contextWindowTokens?: number
    }
  // Appendé à la conversation PARENTE au lancement d'une sous-tâche : l'UI en
  // fait une carte de sub-agent, dont le flux vit sous l'id de la sous-tâche.
  | {
      type: 'subtask-ref'
      subtaskId: string
      provider: Provider
      model: string
      label?: string
    }
  | {
      type: 'debrief-ref'
      debriefId: string
      eventIdFrom: number
      eventIdTo: number
      contentMd: string
      createdAt: string
    }
  | {
      type: 'test-inventory-ref'
      inventoryId: string
      scopes: TestScope[]
      createdAt: string
    }
  | {
      type: 'test-scope-started'
      inventoryId: string
      scopeId: string
      subtaskId: string
      startedAt: string
    }
  | {
      type: 'test-scope-result'
      inventoryId: string
      scopeId: string
      status: 'passed' | 'failed'
      evidenceMd: string
      images: string[]
      guardianFlagIdsAcked: string[]
      completedAt: string
      error?: string
    }
  // Introspection de quota native du provider (payload brut, interprété côté
  // sidecar par le QuotaTracker — cf. sidecar/src/events.ts).
  | { type: 'rate-limit'; provider: Provider; payload: unknown }
  | { type: 'status'; state: 'running' | 'done' | 'error'; error?: string }

// Tout événement venant du sidecar (replay HTTP ou WS) porte l'id de sa ligne :
// c'est la clé de dédup du raccord replay/live.
export type StoredEvent = AppEvent & { id: number }
