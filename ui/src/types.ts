export type Provider = 'claude' | 'codex' | 'grok'
export type ConversationSpeed = 'standard' | 'fast'
export type PresetPermissionMode =
  'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'bypassPermissions'
export type FilesystemScope = 'project-and-ai-roots' | 'full-system'
export type WorkspaceView = 'conversations' | 'git' | 'documents' | 'design' | 'library' | 'routines' | 'fleet' | 'costs' | 'memory' | 'help' | 'progress' | 'dashboard' | 'settings'

/** Joignabilité de claude.ai, renvoyée par `GET /api/design/reachability`.
 *
 *  Ne dit rien du verdict de la webview : un 403 côté sidecar est normal et
 *  compte comme joignable, Cloudflare refusant tout client non-navigateur.
 *  Voir `sidecar/src/design.ts`. `url` est la cible testée, que le bouton de
 *  repli réutilise plutôt que d'en garder une copie codée en dur. */
export type DesignReachability = { url: string } & (
  | { reachable: true; status: number }
  | { reachable: false; message: string }
)

export interface Attachment {
  name: string
  originalName: string
  mimeType: string
  size: number
}

export interface MemoryFile {
  path: string
  size: number
  modifiedAt: string
}

export interface MemoryDocument extends MemoryFile {
  content: string
}

export interface ModelCost {
  model: string
  tokens: number
}

export interface ConversationCost {
  conversationId: string
  title: string
  parentModel: string
  totalTokens: number
  directTokens: number
  subtaskTokens: number
  delegationSavingsTokens: number
  models: ModelCost[]
}

export interface ProjectCostReport {
  projectId: string
  month: string
  totalTokens: number
  directTokens: number
  subtaskTokens: number
  delegationSavingsTokens: number
  conversations: ConversationCost[]
}

export interface FleetItem {
  id: string
  kind: 'turn' | 'subtask' | 'routine' | 'review'
  projectId: string
  projectName: string
  conversationId: string
  title: string
  provider: Provider
  model: string
  startedAt: string
  lastEvent: string
}

export type DomainKind = 'métier' | 'technique'
export type DomainStatus = 'actif' | 'proposé'
export type DomainOrigin = 'auto' | 'manuel'

export interface ProjectDomain {
  id: string
  project_id: string
  name: string
  kind: DomainKind
  status: DomainStatus
  created_at: string
  updated_at: string
}

export interface ConversationDomain {
  id: string
  name: string
  kind: DomainKind
  origin?: DomainOrigin
}

export interface SearchResult {
  kind: 'conversation' | 'event' | 'debrief'
  sourceId: string
  conversationId: string
  projectId: string
  title: string
  excerpt: string
  rank: number
}

export type SkillProvenance =
  | 'claude-global'
  | 'claude-plugin'
  | 'claude-project'
  | 'codex-prompt'
  | 'agents-global'
  | 'agents-project'
  | 'grok-global'
  | 'grok-project'

export interface SkillSummary {
  id: string
  name: string
  invocation: string
  description: string
  triggers: string[]
  provider: Provider
  provenance: SkillProvenance
  path: string
  project_id: string | null
  modified_at: string
  indexed_at: string
  favorite: boolean
}

export interface SkillDetail extends SkillSummary {
  content_md: string
}

export interface SkillSuggestion extends SkillSummary {
  score: number
  reason: string
}

export interface SkillSuggestionResult {
  suggestions: SkillSuggestion[]
  ambiguous: boolean
  resolvedByModel: boolean
}

export interface Workflow {
  id: string
  project_id: string
  name: string
  skill_id: string | null
  skill_name: string
  skill_invocation: string
  prompt: string
  preset_id: string | null
  provider: Provider
  model: string
  effort: string | null
  speed: ConversationSpeed | null
  orchestrator: boolean
  created_at: string
  updated_at: string
}

export interface Routine {
  id: string
  project_id: string
  name: string
  schedule: string
  workflow_id: string | null
  prompt: string | null
  preset_id: string | null
  provider: Provider
  model: string
  effort: string | null
  speed: ConversationSpeed | null
  orchestrator: boolean
  enabled: boolean
  next_run_at: string | null
  created_at: string
  updated_at: string
}

export interface RoutineRun {
  id: string
  routine_id: string
  conversation_id: string | null
  status: 'running' | 'done' | 'error'
  error: string | null
  started_at: string
  completed_at: string | null
  tokens: number
}

export interface AppNotification {
  id: number
  kind: 'routine' | 'long-task'
  title: string
  body: string
  conversation_id: string | null
  created_at: string
}

export interface Project {
  id: string
  name: string
  path: string
  permission_mode: PresetPermissionMode
  filesystem_scope: FilesystemScope
  pinned: boolean
  created_at: string
  default_preset_id: string | null
  default_review_preset_id?: string | null
  default_correction_preset_id?: string | null
  default_scout_preset_id?: string | null
  auto_rescan: boolean
}

export interface Preset {
  id: string
  name: string
  provider: Provider
  model: string
  effort: string | null
  speed: ConversationSpeed | null
  orchestrator: boolean
  subagent_preset_id?: string | null
  subagent_effort?: string | null
  permission_mode: PresetPermissionMode | null
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
  summary: string
  provider: Provider
  model: string
  effort: string | null
  speed: ConversationSpeed | null
  permission_mode?: PresetPermissionMode | null
  orchestrator: boolean
  subagent_preset_id?: string | null
  subagent_effort?: string | null
  continued_from: string | null
  routine_id: string | null
  /** Worktree git dédié ; null = dossier principal du projet (ADR 0001). */
  worktree_path: string | null
  /** Branche courante du projet au moment de la création. */
  created_on_branch: string | null
  ticket_id: string | null
  ticket_key?: string | null
  ticket_instruction: string | null
  domains?: ConversationDomain[]
  proposed_domain_count?: number
  origin_type?: 'sentry' | 'problem' | null
  origin_key?: string | null
  cli_session_id: string | null
  preset_id?: string | null
  pinned: boolean
  /** Renommée à la main : le digest automatique ne l'écrase plus. */
  title_locked: boolean
  digest_turn: number
  message_count?: number
  /** Dernier tour dont la réponse est arrivée à son terme ; au-delà de
   *  `last_read_turn`, la conversation est à lire. */
  answered_turn?: number
  last_read_turn?: number
  archived: boolean
  deleted_at: string | null
  created_at: string
  updated_at: string
}

export type IntegrationType = 'clickup' | 'gitlab' | 'github' | 'notion' | 'sentry'
export type IntegrationStatus = 'ok' | 'dégradée' | 'hors ligne' | 'non configurée' | 'à reconfigurer'

export interface ProjectIntegration {
  id: string
  project_id: string
  type: IntegrationType
  config: Record<string, unknown>
  branch_pattern: string | null
  status: IntegrationStatus
  last_ok_at: string | null
  last_error: string | null
  created_at: string
  updated_at: string
}

export interface DashboardIntegration {
  id: string
  type: IntegrationType
  status: IntegrationStatus
  last_ok_at: string | null
  last_error: string | null
  branch_pattern: string | null
  config: Record<string, unknown>
}

export type TicketSource = 'clickup' | 'notion' | 'git'
export type TicketRefKind = 'branch' | 'mr' | 'pipeline' | 'deployment' | 'sentry_issue'

export interface TicketRef {
  id: string
  ticket_id: string
  kind: TicketRefKind
  ref: string
  payload: Record<string, unknown>
  seen_at: string
}

export interface TicketNote {
  id: string
  ticket_id: string
  body: string
  created_at: string
}

export interface TicketConversationSummary {
  id: string
  title: string
  summary: string
  provider: Provider
  updated_at: string
  worktree_path: string | null
}

export interface TicketRow {
  id: string
  project_id: string
  key: string
  source: TicketSource
  title: string
  status: string
  external_url: string | null
  instruction: string
  payload: Record<string, unknown>
  last_seen_at: string
  archived_at: string | null
  created_at: string
  updated_at: string
  refs: TicketRef[]
  conversations: TicketConversationSummary[]
  notes_count: number
}

export interface EnvironmentState {
  project: string
  name: string
  missing?: boolean
  branch: string | null
  key: string | null
  mergeRequestIid: number | null
  user: string | null
  deployedAt: string | null
  status: string | null
  jobUrl: string | null
}

export interface ReviewRequest {
  project: string
  iid: number
  title: string
  sourceBranch: string
  url: string
  updatedAt: string
  author: string
  draft: boolean
}

export type ProblemCaptureStatus = 'queued' | 'processing' | 'done' | 'error'
export type ProblemStatus = 'open' | 'closed'

export interface ProblemPlan {
  title: string
  instruction: string
}

export interface ProblemCapture {
  id: string
  project_id: string
  raw_text: string
  status: ProblemCaptureStatus
  error: string | null
  created_at: string
  updated_at: string
}

export interface Problem {
  id: string
  public_id: string
  capture_id: string
  project_id: string
  ticket_id: string | null
  ticket_key?: string | null
  ticket_title?: string | null
  ticket_branch?: string | null
  title: string
  context: string
  resolution: string
  plans: ProblemPlan[]
  status: ProblemStatus
  closed_at: string | null
  closed_commit_sha: string | null
  conversation_count: number
  created_at: string
  updated_at: string
}

export interface ProblemProjectPayload {
  projectId: string
  captures: ProblemCapture[]
  problems: Problem[]
}

export interface DashboardPayload {
  projectId: string
  refreshedAt: string
  integrations: DashboardIntegration[]
  tickets: TicketRow[]
  environments: EnvironmentState[]
  toReview: ReviewRequest[]
  problems?: ProblemProjectPayload
}

export type SentryLifecycle = 'new' | 'active' | 'quiet' | 'resolved_remote'
export type SentryVerdict = 'real_fixable' | 'real_investigate' | 'noise' | 'uncertain'

export interface SentryRelevance {
  matched: boolean
  reasons: Array<{ domain: string; signal: string }>
}

export interface SentryTriage {
  issue_id: string
  conversation_id: string | null
  correction_conversation_id: string | null
  ticket_id: string | null
  status: 'idle' | 'running' | 'done' | 'error'
  verdict: SentryVerdict | null
  report: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface SentryIssue {
  id: string
  integration_id: string
  project_id: string
  sentry_issue_id: string
  payload: Record<string, unknown>
  relevance: SentryRelevance
  lifecycle: SentryLifecycle
  first_seen_at: string
  last_seen_at: string
  last_scanned_at: string
  triage?: SentryTriage | null
}

export interface SentryInboxPayload {
  projectId: string
  issues: SentryIssue[]
  integration: {
    status: IntegrationStatus
    lastOkAt: string | null
    lastError: string | null
    tokenConfigured: boolean
  } | null
}

export interface TimeCounter {
  ms: number
  level: number
  levelMs: number
  progress: number
  todayMs: number
}

export interface TimeProjectSummary {
  projectId: string
  name: string
  user: TimeCounter
  agent: TimeCounter
  nextMilestone: number | null
  msToNextMilestone: number | null
}

export interface TimeMilestone {
  hours: number
  reached: boolean
  reachedOn: string | null
}

export interface TimeSnapshot {
  scope: 'project' | 'global'
  projectId: string | null
  projectCount: number
  user: TimeCounter
  agent: TimeCounter
  supervisionMs: number
  writingMs: number
  agentAloneMs: number
  weekUserMs: number
  weekAgentMs: number
  previousWeekUserMs: number
  activeDays: number
  commits: number
  turnCount: number
  backfilledMs: number
  nextMilestone: number | null
  msToNextMilestone: number | null
  milestones: TimeMilestone[]
  projects: TimeProjectSummary[]
  conversations: Record<string, { userMs: number; agentMs: number }>
  /** Temps humain par tour, clé = horodatage de départ. Rempli à la demande. */
  turns: Record<string, number>
}

/** Compteur lu dans le pied de sidebar. Mémorisé par projet. */
export type TimeMode = 'user' | 'agent'

export interface Debrief {
  id: string
  conversation_id: string
  event_id_from: number
  event_id_to: number
  content_md: string
  created_at: string
}

export interface SessionSummary {
  id: string
  conversation_id: string
  event_id_from: number
  event_id_to: number
  content_md: string
  created_at: string
}

export interface ProjectChangelogEntry {
  project_id: string
  repository_path: string
  commit_sha: string
  branch: string
  subject: string
  committed_at: string
  domain_id: string | null
  domain_name: string | null
  product_message: string | null
  enrichment_status: 'pending' | 'enriched'
  imported_at: string
  enriched_at: string | null
}

export interface ProjectChangelogState {
  project_id: string
  status: 'idle' | 'running' | 'error'
  last_started_at: string | null
  last_refreshed_at: string | null
  next_refresh_at: string | null
  error: string | null
  backfill_version: number
}

export interface ProjectChangelogPayload {
  entries: ProjectChangelogEntry[]
  state: ProjectChangelogState
}

// Miroir de sidecar/src/quotas.ts : forme normalisée des providers.
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
  grok: QuotaState | null
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
export type ReviewFlagStatus = 'open' | 'agent_running' | 'treated' | 'ignored' | 'resolved'

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
  status: ReviewFlagStatus
  hunk_hash?: string | null
  subtask_id?: string | null
  user_message?: string | null
  code_provider: Provider
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
  review_speed: ConversationSpeed
  diff_text: string
  error: string | null
  created_at: string
  updated_at: string
  flags: ReviewFlag[]
  code_provider: Provider
  scope: 'worktree' | 'comparison'
  parent_review_id: string | null
}

export interface ReviewStatusSnapshot {
  openBySeverity: Record<ReviewSeverity, number>
  running: { reviewId: string, zoneDone: number, zoneTotal: number } | null
}

/** Événement poussé sur le canal Fleet, ciblé sur un projet. */
export interface ReviewStatusEvent extends ReviewStatusSnapshot {
  projectId: string
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

export interface GitPushCommit {
  sha: string
  subject: string
  authoredAt: string
  parent: string | null
  remoteUrl: string | null
  repositoryPath: string
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

export type GitFileStatus = 'M' | 'A' | 'D' | '?'

export interface GitDirtyFile {
  path: string
  status: GitFileStatus
  added: number
  removed: number
  staged: boolean
}

export interface GitIncomingCommit {
  sha: string
  subject: string
  author: string
  authoredAt: string
}

export interface GitConflictPath {
  path: string
}

export interface GitSnapshot {
  head: string | null
  headParents: string[]
  currentBranch: string | null
  commits: GitCommit[]
  branchCommitShas?: string[]
  branchBase?: string | null
  branches: GitBranch[]
  worktrees: GitWorktree[]
  dirtyFiles?: GitDirtyFile[]
  filePaths?: string[]
  ahead?: number
  behind?: number
  incoming?: GitIncomingCommit[]
  conflicts?: GitConflictPath[]
}

export interface GitDiff {
  base: string
  head: string
  diff: string
}

export interface GitFileContent {
  path: string
  ref: string
  content: string
  sha: string | null
  readonly: boolean
}

export interface GitCommitResult {
  sha: string
  message: string
  paths: string[]
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
  // Titre et résumé régénérés après un tour : met la sidebar à jour, ne s'affiche
  // pas dans le fil.
  | { type: 'conversation-digest'; title: string; summary: string; domains?: ConversationDomain[]; proposedDomainCount?: number }
  | { type: 'user-message'; text: string; images: string[]; attachments?: Attachment[]; steering?: boolean }
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
      type: 'session-summary-ref'
      summaryId: string
      eventIdFrom: number
      eventIdTo: number
      contentMd: string
      createdAt: string
    }
  | {
      type: 'html-document-ref'
      documentId: string
      title: string
      summary?: string
      kind?: 'html'
      mimeType?: 'text/html'
      originalName?: string
      sizeBytes: number
      createdAt: string
      expiresAt: string | null
    }
  | {
      type: 'document-ref'
      documentId: string
      title: string
      summary?: string
      kind: 'html' | 'pdf'
      mimeType: string
      originalName: string
      sizeBytes: number
      createdAt: string
      expiresAt: string | null
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
  | {
      type: 'review-report-ref'
      reviewId: string
      createdAt: string
    }
  // Introspection de quota native du provider (payload brut, interprété côté
  // sidecar par le QuotaTracker — cf. sidecar/src/events.ts).
  | { type: 'rate-limit'; provider: Provider; payload: unknown }
  | { type: 'status'; state: 'running' | 'done' | 'error'; error?: string }

// Tout événement venant du sidecar (replay HTTP ou WS) porte l'id de sa ligne :
// c'est la clé de dédup du raccord replay/live.
export type StoredEvent = AppEvent & { id: number }

export type HtmlDocumentState = 'available' | 'retained' | 'expired' | 'deleted'

export interface HtmlDocument {
  id: string
  conversationId: string
  conversationTitle: string | null
  projectId: string | null
  projectName: string | null
  title: string
  summary: string | null
  kind: 'html' | 'pdf'
  mimeType: string
  originalName: string
  sizeBytes: number
  sha256: string
  createdAt: string
  expiresAt: string | null
  retainedAt: string | null
  expiredAt: string | null
  deletedAt: string | null
  state: HtmlDocumentState
  searchSnippet: string | null
  matchCount: number
}

export type DocumentArtifact = HtmlDocument
