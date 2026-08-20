import type { ServerWebSocket } from "bun";
import { basename, extname } from "node:path";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { MediaAttachment, Provider, StoredEvent } from "./events";
import type { MediaStore } from "./media";
import type { ConversationRunner } from "./runner";
import type { Conversation, ConversationStore } from "./stores/conversations";
import type { ProjectStore } from "./stores/projects";
import type {
  PresetInput,
  PresetPermissionMode,
  PresetStore,
} from "./stores/presets";
import {
  defaultReviewConfig,
  normalizePresetPermissionMode,
} from "./stores/presets";
import { INTEGRATION_TOKENS_KEY, type SettingsStore } from "./stores/settings";
import type { QuotaTracker } from "./quotas";
import type { QuotaRefresher } from "./quota-refresh";
import { SubtaskLimitError, type SubtaskRunner } from "./subtasks";
import { dispatchAgentConfig, DispatchConflictError, type CorrectionAgentConfig, type ReviewRunner } from "./reviews";
import {
  DebriefAlreadyRunningError,
  NoNewSessionSummaryEventsError,
  NoNewDebriefEventsError,
  type HandoffDebriefArtifact,
  type DebriefRunner,
} from "./debriefs";
import { DESIGN_URL, isResumableDesignUrl, probeDesignReachability } from "./design";
import { GitProjectError, type GitProjectService } from "./git";
import {
  TesterBusyError,
  TestScopeAlreadyRunningError,
  type TesterRunner,
} from "./testing";
import type { SkillInventory, SkillProvider } from "./skills";
import type { SkillSuggestionService } from "./skill-suggestions";
import { SkillAlreadyExistsError, type SkillComposer } from "./skill-composer";
import type { WorkflowInput, WorkflowStore } from "./stores/workflows";
import type { NotificationStore } from "./stores/notifications";
import type { RoutineInput, RoutineScheduler, RoutineStore } from "./routines";
import { fleetSnapshot } from "./fleet";
import type { SearchIndex } from "./search";
import type { CostStore } from "./costs";
import {
  MemoryFileExistsError,
  MemoryFileTooLargeError,
  MemoryPathError,
  type MemoryStore,
} from "./memory";
import type { GamificationService } from "./gamification";
import {
  HtmlDocumentError,
  type HtmlDocumentService,
} from "./html-documents";
import { FILESYSTEM_SCOPES, type FilesystemScope } from "./access";
import { actionFormat } from "./response-format";
import { conductorToolTokens } from "./conductor-mcp";
import { dashboardPayload } from "./dashboard";
import { composeTicketBrief } from "./ticket-brief";
import {
  claudeServerDefinitions,
  codexServerDefinitions,
  listMcpServers,
  usedMcpServers,
} from "./mcp-inventory";
import { measureMcpServers } from "./mcp-probe";
import { verifyMcpContextCost } from "./mcp-verify";
import { instructionsTokens } from "./context-profile";
import type { McpServerWeight } from "./mcp-probe";
import type { IntegrationsRefresher } from "./integrations/refresher";
import { compileBranchPattern, extractTicketKey } from "./ticket-key";
import type { IntegrationStore, IntegrationType } from "./stores/integrations";
import type { Ticket, TicketStore } from "./stores/tickets";

type EventListener = (conversationId: string, event: StoredEvent) => void;

export class ConversationEventBus {
  private listeners = new Set<EventListener>();

  broadcast = (conversationId: string, event: StoredEvent): void => {
    for (const listener of this.listeners) listener(conversationId, event);
  };

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export interface ServerDeps {
  port: number;
  projects: ProjectStore;
  conversations: ConversationStore;
  media: MediaStore;
  runner: ConversationRunner;
  events: ConversationEventBus;
  quotas: QuotaTracker;
  quotaRefresher: QuotaRefresher;
  subtasks: SubtaskRunner;
  presets: PresetStore;
  settings: SettingsStore;
  reviews: ReviewRunner;
  debriefs: DebriefRunner;
  git: GitProjectService;
  testers: TesterRunner;
  skills: SkillInventory;
  skillSuggestions: SkillSuggestionService;
  skillComposer: SkillComposer;
  workflows: WorkflowStore;
  routineStore: RoutineStore;
  routines: RoutineScheduler;
  notifications: NotificationStore;
  search: SearchIndex;
  costs: CostStore;
  memory: MemoryStore;
  integrations: IntegrationStore;
  tickets: TicketStore;
  integrationsRefresher: IntegrationsRefresher;
  gamification?: GamificationService;
  htmlDocuments?: HtmlDocumentService;
  /**
   * Arrêt propre du sidecar, déclenché par `POST /api/shutdown` : c'est ce qui
   * permet à un sidecar plus récent de reprendre le port (cf. claimServer).
   */
  shutdown?: () => void;
}

interface HandoffTargetConfig {
  provider: Provider;
  model: string;
  effort: string | null;
  speed: "standard" | "fast" | null;
  orchestrator: boolean;
}

async function ticketBriefFor(
  deps: ServerDeps,
  ticket: Ticket,
  excludeConversationId: string,
): Promise<string> {
  const siblings = deps.tickets.conversationsByTicket(ticket.id)
    .filter((item) => item.id !== excludeConversationId)
    .slice(0, 5)
    .map((item) => ({
      id: item.id,
      title: item.title,
      summary: item.summary,
      debrief: deps.debriefs.latest(item.id)?.content_md ?? null,
    }));
  return composeTicketBrief({
    ticket,
    branches: deps.tickets.branchesOf(ticket.id),
    refs: deps.tickets.refsByTicket(ticket.id),
    notes: deps.tickets.notesByTicket(ticket.id),
    clickup: await deps.integrationsRefresher.clickUpContext(ticket.project_id, ticket.key),
    siblings,
  });
}

async function createContinuationFromHandoff(
  deps: ServerDeps,
  source: Conversation,
  target: HandoffTargetConfig,
  artifact: HandoffDebriefArtifact,
): Promise<Conversation> {
  const snapshot = deps.git.snapshot(source.project_id);
  const continuation = deps.conversations.create({
    projectId: source.project_id,
    provider: target.provider,
    model: target.model,
    effort: target.effort,
    speed: target.speed,
    orchestrator: target.orchestrator,
    subagentPresetId: source.subagent_preset_id,
    subagentEffort: source.subagent_effort,
    continuedFrom: source.id,
    handoffPending: true,
    createdOnBranch: snapshot.currentBranch,
    firstMessage: `Suite — ${source.title}`,
  });
  const seed = [
    `Voici l'historique des débriefs de passation de la conversation ${source.title} :`,
    "",
    artifact.contentMd,
    "",
    "Prends ce contexte comme point de départ. Cite les références [événement #N]",
    "quand elles étayent ta réponse, puis confirme brièvement la reprise.",
  ].join("\n");
  try {
    const outcome = await deps.runner.runTurn(continuation.id, seed, []);
    if (outcome.state === "error") {
      throw new Error(outcome.error ?? "échec du provider cible");
    }
    if (!deps.conversations.completeHandoff(continuation.id)) {
      throw new Error("état de passation introuvable après le premier tour");
    }
    const created = deps.conversations.get(continuation.id);
    if (!created) throw new Error("conversation de passation introuvable");
    return created;
  } catch (error) {
    // Le provider cible peut avoir délégué avant d'échouer. Attendre l'arrêt
    // de ses sous-tâches empêche qu'elles réécrivent des events sous leurs ids
    // après la transaction de nettoyage.
    await deps.subtasks.cancelByConversation(continuation.id);
    deps.conversations.deleteFailedContinuation(continuation.id);
    throw error;
  }
}

// Deux canaux WS sur la même route : par conversation (défaut historique) et le
// canal global `quotas`.
type WebSocketData =
  | { channel: "conversation"; conversationId: string }
  | { channel: "quotas" }
  | { channel: "fleet" }
  | { channel: "tickets"; projectId: string };

const EFFORTS_BY_PROVIDER = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["low", "medium", "high", "xhigh"],
} as const satisfies Record<Provider, readonly string[]>;
const MODELS_BY_PROVIDER = {
  claude: ["fable-5", "opus", "sonnet", "haiku"],
  codex: ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra"],
} as const satisfies Record<Provider, readonly string[]>;
const SPEEDS = ["standard", "fast"] as const;
const DEFAULT_MEDIA_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MESSAGE_MEDIA_MAX_BYTES = 25 * 1024 * 1024;
const REVIEW_COOLDOWN_MS = 10_000;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const TAURI_CORS_HEADERS = {
  "access-control-allow-origin": "tauri://localhost",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, x-file-name",
  vary: "Origin",
};

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: TAURI_CORS_HEADERS });
}

function empty(status: number): Response {
  return new Response(null, { status, headers: TAURI_CORS_HEADERS });
}

async function readObject(request: Request): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await request.json();
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("objet attendu");
    }
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "corps JSON invalide");
  }
}

function requiredString(
  body: Record<string, unknown>,
  field: string,
): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, `champ ${field} invalide`);
  }
  return value;
}

function safeFilename(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return normalized || "conversation";
}

function handoffDocument(title: string, contentMd: string): string {
  return [
    `# Handoff — ${title}`,
    "",
    "Ce document transfère le contexte de travail à une nouvelle session Pupitre.",
    "Les références détaillées restent dans le projet et dans la conversation source.",
    "",
    "## Débrief de passation",
    "",
    contentMd,
    "",
  ].join("\n");
}

function memoryHttpError(error: unknown, fallback = "fichier mémoire inconnu"): never {
  if (error instanceof MemoryFileTooLargeError) {
    throw new HttpError(413, error.message);
  }
  if (error instanceof MemoryPathError) {
    throw new HttpError(400, error.message);
  }
  if (error instanceof MemoryFileExistsError) {
    throw new HttpError(409, error.message);
  }
  throw new HttpError(404, fallback);
}

function htmlDocumentHttpError(error: unknown): never {
  if (!(error instanceof HtmlDocumentError)) throw error;
  switch (error.code) {
    case "conversation-not-found":
    case "document-not-found":
      throw new HttpError(404, error.message);
    case "document-unavailable":
      throw new HttpError(410, error.message);
    case "source-too-large":
      throw new HttpError(413, error.message);
    case "view-token-invalid":
      throw new HttpError(403, error.message);
    default:
      throw new HttpError(400, error.message);
  }
}

function reviewModel(model: string, provider: Provider, field: string): string {
  const value = model.trim();
  if (!(MODELS_BY_PROVIDER[provider] as readonly string[]).includes(value)) {
    throw new HttpError(400, `${field} invalide pour ${provider}`);
  }
  return value;
}

function optionalImages(body: Record<string, unknown>): string[] {
  const value = body.images;
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new HttpError(400, "champ images invalide");
  }
  return value as string[];
}

function byteLimit(envName: string, fallback: number): number {
  const value = Number(process.env[envName]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function validatedImages(body: Record<string, unknown>, media: MediaStore): string[] {
  const images = optionalImages(body);
  const mediaLimit = byteLimit("PUPITRE_MEDIA_MAX_BYTES", DEFAULT_MEDIA_MAX_BYTES);
  const totalLimit = byteLimit(
    "PUPITRE_MESSAGE_MEDIA_MAX_BYTES",
    DEFAULT_MESSAGE_MEDIA_MAX_BYTES,
  );
  let total = 0;
  for (const name of images) {
    let size: number;
    try {
      size = media.byteLength(name);
    } catch {
      throw new HttpError(400, `media inconnu ou invalide : ${name}`);
    }
    if (size > mediaLimit) {
      throw new HttpError(413, `image trop volumineuse : ${name}`);
    }
    total += size;
    if (total > totalLimit) {
      throw new HttpError(413, "taille totale des images dépassée");
    }
  }
  return images;
}

function optionalAttachments(body: Record<string, unknown>): unknown[] {
  const value = body.attachments;
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new HttpError(400, "champ attachments invalide");
  return value;
}

function validatedAttachments(
  body: Record<string, unknown>,
  media: MediaStore,
): MediaAttachment[] {
  const attachments = optionalAttachments(body);
  const mediaLimit = byteLimit("PUPITRE_MEDIA_MAX_BYTES", DEFAULT_MEDIA_MAX_BYTES);
  const totalLimit = byteLimit(
    "PUPITRE_MESSAGE_MEDIA_MAX_BYTES",
    DEFAULT_MESSAGE_MEDIA_MAX_BYTES,
  );
  let total = 0;
  return attachments.map((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new HttpError(400, "attachment invalide");
    }
    const item = value as Record<string, unknown>;
    if (
      typeof item.name !== "string"
      || typeof item.originalName !== "string"
      || typeof item.mimeType !== "string"
    ) {
      throw new HttpError(400, "attachment invalide");
    }
    let size: number;
    try {
      size = media.byteLength(item.name);
    } catch {
      throw new HttpError(400, `media inconnu ou invalide : ${item.name}`);
    }
    if (size > mediaLimit) {
      throw new HttpError(413, `fichier trop volumineux : ${item.originalName}`);
    }
    total += size;
    if (total > totalLimit) {
      throw new HttpError(413, "taille totale des pièces jointes dépassée");
    }
    return {
      name: item.name,
      originalName: item.originalName,
      mimeType: item.mimeType,
      size,
    };
  });
}

function messageWithAttachments(
  body: Record<string, unknown>,
  media: MediaStore,
): { message: string; images: string[]; attachments: MediaAttachment[] } {
  const value = body.message;
  if (typeof value !== "string") {
    throw new HttpError(400, "champ message invalide");
  }
  const images = validatedImages(body, media);
  const attachments = validatedAttachments(body, media);
  const attachmentImages = attachments
    .filter((attachment) => attachment.mimeType.startsWith("image/"))
    .map((attachment) => attachment.name);
  const imageNames = [...new Set([...images, ...attachmentImages])];
  if (value.trim() === "" && imageNames.length === 0) {
    throw new HttpError(400, "message ou image requis");
  }
  return { message: value, images: imageNames, attachments };
}

function optionalEffort(
  body: Record<string, unknown>,
  provider: Provider,
): string | null {
  const value = body.effort;
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "string"
    || !(EFFORTS_BY_PROVIDER[provider] as readonly string[]).includes(value)
  ) {
    throw new HttpError(400, `effort invalide pour ${provider}`);
  }
  return value;
}

function optionalSpeed(
  body: Record<string, unknown>,
  provider: Provider,
): "standard" | "fast" | null {
  const value = body.speed;
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "string"
    || !(SPEEDS as readonly string[]).includes(value)
  ) {
    throw new HttpError(400, "vitesse invalide");
  }
  if (provider === "claude" && value === "fast") {
    throw new HttpError(400, "vitesse fast indisponible pour claude");
  }
  return value as "standard" | "fast";
}

function optionalLabel(body: Record<string, unknown>): string | null {
  const value = body.label;
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new HttpError(400, "champ label invalide");
  return value;
}

/** Chaîne facultative, vidée de ses blancs ; une chaîne vide vaut absente. */
function optionalTrimmed(body: Record<string, unknown>, field: string): string | null {
  const value = body[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new HttpError(400, `champ ${field} invalide`);
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function publicSettings(deps: ServerDeps): Record<string, unknown> {
  const settings = deps.settings.all();
  const tokens = settings[INTEGRATION_TOKENS_KEY];
  const integrationTokens = typeof tokens === "object" && tokens !== null && !Array.isArray(tokens)
    ? Object.fromEntries(Object.keys(tokens).map((key) => [key, true]))
    : {};
  return {
    ...settings,
    [INTEGRATION_TOKENS_KEY]: integrationTokens,
    conductorToolTokens: conductorToolTokens(),
  };
}

function optionalBoolean(
  body: Record<string, unknown>,
  field: string,
  fallback: boolean,
): boolean {
  const value = body[field];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new HttpError(400, `champ ${field} invalide`);
  return value;
}

const COMMON_SUBAGENT_EFFORTS = ["low", "medium", "high", "xhigh"] as const;
const ANY_SUBAGENT_EFFORTS = [...COMMON_SUBAGENT_EFFORTS, "max"] as const;

function optionalNamedEffort(
  body: Record<string, unknown>,
  field: string,
  provider?: Provider,
): string | null {
  const value = body[field];
  if (value === undefined || value === null || value === "") return null;
  const allowed = provider
    ? EFFORTS_BY_PROVIDER[provider]
    : ANY_SUBAGENT_EFFORTS;
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new HttpError(400, `${field} invalide${provider ? ` pour ${provider}` : ""}`);
  }
  return value;
}

function optionalNamedPresetId(
  body: Record<string, unknown>,
  field: string,
): string | null {
  const value = body[field];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, `${field} invalide`);
  }
  return value;
}

function inferPresetId(
  input: {
    provider: Provider
    model: string
    effort: string | null
    speed: "standard" | "fast" | null
    orchestrator: boolean
  },
  deps: ServerDeps,
): string | null {
  const matches = deps.presets.list().filter((preset) => (
    preset.provider === input.provider
      && preset.model === input.model
      && preset.effort === input.effort
      && preset.speed === input.speed
      && preset.orchestrator === input.orchestrator
  ));
  return matches.length === 1 ? matches[0]!.id : null;
}

function validatePresetSubagentConfig(input: PresetInput, deps: ServerDeps): void {
  if (input.subagent_preset_id === null || input.subagent_preset_id === undefined) {
    if (input.subagent_effort !== null && input.subagent_effort !== undefined) {
      const allowed = COMMON_SUBAGENT_EFFORTS as readonly string[];
      if (!allowed.includes(input.subagent_effort)) {
        throw new HttpError(400, "subagent_effort invalide");
      }
    }
    return;
  }
  const target = deps.presets.get(input.subagent_preset_id);
  if (!target) throw new HttpError(404, "preset sub-agent inconnu");
  if (
    input.subagent_effort !== null
    && input.subagent_effort !== undefined
    && !(EFFORTS_BY_PROVIDER[target.provider] as readonly string[]).includes(input.subagent_effort)
  ) {
    throw new HttpError(400, `subagent_effort invalide pour ${target.provider}`);
  }
}

function optionalPresetPermissionMode(
  body: Record<string, unknown>,
): PresetPermissionMode | null | undefined {
  if (body.permission_mode === undefined) return undefined;
  try {
    return normalizePresetPermissionMode(body.permission_mode);
  } catch {
    throw new HttpError(
      400,
      "permission_mode invalide (default, acceptEdits, plan, dontAsk ou yolo/autonomous)",
    );
  }
}

function conversationSubagentConfig(
  body: Record<string, unknown>,
  deps: ServerDeps,
): { subagentPresetId: string | null; subagentEffort: string | null } {
  const subagentPresetId = optionalNamedPresetId(body, "subagentPresetId");
  const target = subagentPresetId ? deps.presets.get(subagentPresetId) : null;
  if (subagentPresetId && !target) throw new HttpError(404, "preset sub-agent inconnu");
  const subagentEffort = optionalNamedEffort(body, "subagentEffort", target?.provider);
  if (!target && subagentEffort === "max") {
    throw new HttpError(400, "subagentEffort max exige un preset Claude");
  }
  return {
    subagentPresetId,
    subagentEffort,
  };
}

export function effectiveSubtaskConfig(
  conversation: Conversation,
  requested: {
    provider: Provider;
    model: string;
    effort: string | null;
    speed: "standard" | "fast" | null;
  },
  presets: PresetStore,
): typeof requested {
  const lockedPreset = conversation.subagent_preset_id
    ? presets.get(conversation.subagent_preset_id)
    : null;
  if (!lockedPreset) {
    return {
      ...requested,
      effort: conversation.subagent_effort ?? requested.effort,
    };
  }
  return {
    provider: lockedPreset.provider,
    model: lockedPreset.model,
    effort: conversation.subagent_effort ?? lockedPreset.effort,
    speed: lockedPreset.speed,
  };
}

function presetInput(body: Record<string, unknown>): PresetInput {
  const name = requiredString(body, "name");
  const provider = requiredString(body, "provider");
  if (provider !== "claude" && provider !== "codex") {
    throw new HttpError(400, "provider invalide");
  }
  const reviewProviderValue = body.review_provider;
  if (
    reviewProviderValue !== undefined
    && reviewProviderValue !== "claude"
    && reviewProviderValue !== "codex"
  ) {
    throw new HttpError(400, "review_provider invalide");
  }
  const reviewProvider = reviewProviderValue as Provider | undefined;
  const reviewModelValue = body.review_model;
  if (
    reviewModelValue !== undefined
    && (typeof reviewModelValue !== "string" || reviewModelValue.trim() === "")
  ) {
    throw new HttpError(400, "review_model invalide");
  }
  if (typeof reviewModelValue === "string") {
    reviewModel(reviewModelValue, reviewProvider ?? provider, "review_model");
  }
  const reviewEffortValue = body.review_effort;
  if (reviewEffortValue !== undefined) {
    const effortProvider = reviewProvider ?? provider;
    if (
      typeof reviewEffortValue !== "string"
      || !(EFFORTS_BY_PROVIDER[effortProvider] as readonly string[]).includes(reviewEffortValue)
    ) {
      throw new HttpError(400, `review_effort invalide pour ${effortProvider}`);
    }
  }
  const subagentPresetIdValue = body.subagent_preset_id;
  const subagentEffortValue = body.subagent_effort;
  const permissionMode = optionalPresetPermissionMode(body);
  return {
    name,
    provider,
    model: requiredString(body, "model"),
    effort: optionalEffort(body, provider),
    speed: optionalSpeed(body, provider),
    orchestrator: optionalBoolean(body, "orchestrator", true),
    ...(subagentPresetIdValue !== undefined
      ? { subagent_preset_id: optionalNamedPresetId(body, "subagent_preset_id") }
      : {}),
    ...(subagentEffortValue !== undefined
      ? { subagent_effort: optionalNamedEffort(body, "subagent_effort") }
      : {}),
    ...(permissionMode !== undefined ? { permission_mode: permissionMode } : {}),
    ...(reviewProvider ? { review_provider: reviewProvider } : {}),
    ...(typeof reviewModelValue === "string" ? { review_model: reviewModelValue } : {}),
    ...(typeof reviewEffortValue === "string" ? { review_effort: reviewEffortValue } : {}),
  };
}

function quotaThresholds(body: Record<string, unknown>): {
  lastHour: boolean;
  usedPercent: number | null;
} {
  const value = body.quotaThresholds;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "champ quotaThresholds invalide");
  }
  const thresholds = value as Record<string, unknown>;
  if (typeof thresholds.lastHour !== "boolean") {
    throw new HttpError(400, "seuil lastHour invalide");
  }
  const usedPercent = thresholds.usedPercent;
  if (
    usedPercent !== null
    && (typeof usedPercent !== "number"
      || !Number.isFinite(usedPercent)
      || usedPercent < 0
      || usedPercent > 100)
  ) {
    throw new HttpError(400, "seuil usedPercent invalide");
  }
  return { lastHour: thresholds.lastHour, usedPercent };
}

function requiredPinned(body: Record<string, unknown>): boolean {
  if (typeof body.pinned !== "boolean") {
    throw new HttpError(400, "champ pinned invalide");
  }
  return body.pinned;
}

function resolveReviewConfig(
  project: { default_review_preset_id: string | null; default_preset_id: string | null },
  conversation: { provider: Provider },
  presets: PresetStore,
): { provider: Provider; model: string; effort: string; speed: "standard" | "fast" } {
  const presetId = project.default_review_preset_id ?? project.default_preset_id;
  const preset = presetId ? presets.get(presetId) : null;
  if (!preset) return { ...defaultReviewConfig(conversation.provider), speed: "standard" };
  return {
    provider: preset.review_provider,
    model: preset.review_model,
    effort: preset.review_effort,
    speed: preset.review_provider === "codex" && preset.speed === "fast" ? "fast" : "standard",
  };
}

function resolveCorrectionConfig(
  project: { default_correction_preset_id: string | null },
  conversation: Conversation,
  codeProvider: Provider,
  presets: PresetStore,
): CorrectionAgentConfig {
  const preset = project.default_correction_preset_id ? presets.get(project.default_correction_preset_id) : null;
  if (!preset) return dispatchAgentConfig(conversation, codeProvider);
  return {
    provider: preset.provider,
    model: preset.model,
    effort: preset.effort ?? defaultReviewConfig(preset.provider).effort,
    speed: preset.provider === "codex" ? (preset.speed ?? "standard") : null,
  };
}

function reviewCooldownSeconds(
  reviews: ReturnType<ReviewRunner["listByProject"]>,
  conversationId: string,
  now = Date.now(),
): number {
  const latest = reviews.find((review) => review.conversation_id === conversationId);
  if (!latest) return 0;
  return Math.max(0, Math.ceil((REVIEW_COOLDOWN_MS - (now - Date.parse(latest.created_at))) / 1_000));
}

function mediaMimeType(contentType: string | null, fileName: string | null): string {
  const declared = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (declared && declared !== "application/octet-stream") return declared;
  const extension = extname(fileName ?? "").toLowerCase();
  switch (extension) {
    case ".csv": return "text/csv";
    case ".doc": return "application/msword";
    case ".docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".json": return "application/json";
    case ".md": return "text/markdown";
    case ".pdf": return "application/pdf";
    case ".txt": return "text/plain";
    case ".xls": return "application/vnd.ms-excel";
    case ".xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".xml": return "application/xml";
    case ".zip": return "application/zip";
    default: return declared || "application/octet-stream";
  }
}

function mediaExtension(contentType: string | null, fileName: string | null): string {
  const mime = mediaMimeType(contentType, fileName);
  switch (mime) {
    case "image/jpeg": return "jpg";
    case "image/gif": return "gif";
    case "image/webp": return "webp";
    case "image/svg+xml": return "svg";
    case "image/png":
      return "png";
    case "application/pdf": return "pdf";
    case "application/msword": return "doc";
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document": return "docx";
    case "application/vnd.ms-excel": return "xls";
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": return "xlsx";
    case "application/json": return "json";
    case "application/xml": return "xml";
    case "application/zip": return "zip";
    case "text/csv": return "csv";
    case "text/markdown": return "md";
    case "text/plain": return "txt";
    default: return extname(fileName ?? "").replace(".", "") || "bin";
  }
}

function fileNameHeader(value: string | null): string {
  if (!value) return "piece-jointe";
  try {
    return basename(decodeURIComponent(value)) || "piece-jointe";
  } catch {
    return basename(value) || "piece-jointe";
  }
}

function droppedFilePath(value: string): string {
  const path = value.trim();
  if (!path.startsWith("file://")) return path;
  try {
    return fileURLToPath(path);
  } catch {
    return path;
  }
}

function routeId(pathname: string, pattern: RegExp): string | null {
  const match = pathname.match(pattern);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    throw new HttpError(400, "identifiant invalide");
  }
}

function workflowInput(
  body: Record<string, unknown>,
  projectId: string,
  deps: ServerDeps,
): WorkflowInput {
  const skillId = requiredString(body, "skillId");
  const skill = deps.skills.get(skillId, projectId);
  if (!skill || (skill.project_id !== null && skill.project_id !== projectId)) {
    throw new HttpError(404, "skill indisponible pour ce projet");
  }
  const presetIdValue = body.presetId;
  if (presetIdValue !== null && presetIdValue !== undefined && typeof presetIdValue !== "string") {
    throw new HttpError(400, "presetId invalide");
  }
  const preset = typeof presetIdValue === "string" ? deps.presets.get(presetIdValue) : null;
  if (typeof presetIdValue === "string" && !preset) throw new HttpError(404, "preset inconnu");
  let provider: Provider;
  let model: string;
  let effort: string | null;
  let speed: "standard" | "fast" | null;
  let orchestrator: boolean;
  if (preset) {
    ({ provider, model, effort, speed, orchestrator } = preset);
  } else {
    const providerValue = requiredString(body, "provider");
    if (providerValue !== "claude" && providerValue !== "codex") {
      throw new HttpError(400, "provider invalide");
    }
    provider = providerValue;
    model = requiredString(body, "model");
    effort = optionalEffort(body, provider);
    speed = optionalSpeed(body, provider);
    orchestrator = optionalBoolean(body, "orchestrator", true);
  }
  return {
    projectId,
    name: requiredString(body, "name"),
    skillId: skill.id,
    skillName: skill.name,
    skillInvocation: skill.invocation,
    prompt: requiredString(body, "prompt"),
    presetId: preset?.id ?? null,
    provider,
    model,
    effort,
    speed,
    orchestrator,
  };
}

function routineInput(
  body: Record<string, unknown>,
  projectId: string,
  deps: ServerDeps,
  enabledFallback: boolean,
): RoutineInput {
  const workflowIdValue = body.workflowId;
  if (workflowIdValue !== null && workflowIdValue !== undefined && typeof workflowIdValue !== "string") {
    throw new HttpError(400, "workflowId invalide");
  }
  const workflow = typeof workflowIdValue === "string" ? deps.workflows.get(workflowIdValue) : null;
  if (typeof workflowIdValue === "string" && (!workflow || workflow.project_id !== projectId)) {
    throw new HttpError(404, "workflow inconnu pour ce projet");
  }
  const promptValue = body.prompt;
  const prompt = typeof promptValue === "string" && promptValue.trim() ? promptValue.trim() : null;
  if (!workflow && !prompt) throw new HttpError(400, "workflow ou prompt requis");
  const presetIdValue = body.presetId;
  if (presetIdValue !== null && presetIdValue !== undefined && typeof presetIdValue !== "string") {
    throw new HttpError(400, "presetId invalide");
  }
  const preset = typeof presetIdValue === "string" ? deps.presets.get(presetIdValue) : null;
  if (typeof presetIdValue === "string" && !preset) throw new HttpError(404, "preset inconnu");
  const config = preset ?? workflow;
  let provider: Provider;
  let model: string;
  let effort: string | null;
  let speed: "standard" | "fast" | null;
  let orchestrator: boolean;
  if (config) {
    ({ provider, model, effort, speed, orchestrator } = config);
  } else {
    const providerValue = requiredString(body, "provider");
    if (providerValue !== "claude" && providerValue !== "codex") {
      throw new HttpError(400, "provider invalide");
    }
    provider = providerValue;
    model = requiredString(body, "model");
    effort = optionalEffort(body, provider);
    speed = optionalSpeed(body, provider);
    orchestrator = optionalBoolean(body, "orchestrator", true);
  }
  return {
    projectId,
    name: requiredString(body, "name"),
    schedule: requiredString(body, "schedule"),
    workflowId: workflow?.id ?? null,
    prompt: workflow ? null : prompt,
    presetId: preset?.id ?? null,
    provider,
    model,
    effort,
    speed,
    orchestrator,
    enabled: optionalBoolean(body, "enabled", enabledFallback),
  };
}

export function createServer(deps: ServerDeps) {
  const sockets = new Map<string, Set<ServerWebSocket<WebSocketData>>>();
  const quotaSockets = new Set<ServerWebSocket<WebSocketData>>();
  const fleetSockets = new Set<ServerWebSocket<WebSocketData>>();
  const ticketSockets = new Map<string, Set<ServerWebSocket<WebSocketData>>>();
  let fleetTimer: ReturnType<typeof setInterval> | null = null;
  const currentFleet = () => fleetSnapshot(deps);
  const broadcastFleet = () => {
    const message = JSON.stringify(currentFleet());
    for (const socket of fleetSockets) {
      try {
        socket.send(message);
      } catch {
        fleetSockets.delete(socket);
      }
    }
    if (fleetSockets.size === 0 && fleetTimer) {
      clearInterval(fleetTimer);
      fleetTimer = null;
    }
  };
  const broadcastReviewStatus = () => {
    // Le canal Fleet porte aussi le statut des reviews : l'UI garde un unique
    // flux temps réel pour la barre globale et le bouton Git.
    broadcastFleet();
    for (const project of deps.projects.list()) {
      const status = deps.reviews.reviewStatus(project.id);
      if (!status) continue;
      // Le canal est global à l'application : l'id évite qu'un push provenant
      // d'un autre projet écrase le statut actuellement affiché par le client.
      const message = JSON.stringify({ projectId: project.id, ...status });
      for (const socket of fleetSockets) {
        try {
          socket.send(message);
        } catch {
          fleetSockets.delete(socket);
        }
      }
    }
  };
  deps.reviews.subscribeStatus(broadcastReviewStatus);
  const broadcastDashboard = (projectId: string) => {
    const subscribers = ticketSockets.get(projectId);
    if (!subscribers || subscribers.size === 0) return;
    const message = JSON.stringify(dashboardPayload(projectId, deps.integrations, deps.tickets));
    for (const socket of subscribers) {
      try {
        socket.send(message);
      } catch {
        subscribers.delete(socket);
      }
    }
    if (subscribers.size === 0) ticketSockets.delete(projectId);
  };
  deps.events.subscribe((conversationId, event) => {
    const message = JSON.stringify(event);
    for (const socket of sockets.get(conversationId) ?? []) {
      try {
        socket.send(message);
      } catch {
        sockets.get(conversationId)?.delete(socket);
      }
    }
  });
  deps.integrationsRefresher.subscribe(broadcastDashboard);
  deps.quotas.subscribe((state) => {
    const message = JSON.stringify(state);
    for (const socket of quotaSockets) {
      try {
        socket.send(message);
      } catch {
        quotaSockets.delete(socket);
      }
    }
  });

  return Bun.serve<WebSocketData>({
    port: deps.port,
    hostname: "127.0.0.1",
    async fetch(request, server) {
      try {
        const origin = request.headers.get("origin");
        if (
          origin !== null
          && origin !== "tauri://localhost"
          && !origin.startsWith("http://localhost:")
          && !origin.startsWith("http://127.0.0.1:")
        ) {
          throw new HttpError(403, "origine interdite");
        }
        if (request.method === "OPTIONS") return empty(204);

        const url = new URL(request.url);
        const { pathname } = url;

        if (request.method === "GET" && pathname === "/api/health") {
          return json({ ok: true });
        }

        // N'ouvre jamais la fenêtre et ne la bloque jamais : dit seulement si
        // claude.ai répond, pour que la vue Design distingue « hors ligne » de
        // « ouvre plutôt dans le navigateur ». L'URL voyage avec la réponse pour
        // que le bouton de repli ne garde pas une copie codée en dur.
        if (request.method === "GET" && pathname === "/api/design/reachability") {
          return json({ ...(await probeDesignReachability()), url: DESIGN_URL });
        }

        if (request.method === "GET" && pathname === "/api/gamification") {
          if (!deps.gamification) throw new HttpError(501, "progression non câblée");
          const projectId = url.searchParams.get("projectId") ?? undefined;
          if (projectId && !deps.projects.get(projectId)) throw new HttpError(404, "projet inconnu");
          return json(deps.gamification.snapshot(projectId));
        }

        if (request.method === "POST" && pathname === "/api/gamification/activity") {
          if (!deps.gamification) throw new HttpError(501, "progression non câblée");
          const body = await readObject(request);
          const day = requiredString(body, "day");
          const activeMs = body.activeMs;
          if (typeof activeMs !== "number" || !Number.isFinite(activeMs) || activeMs < 0 || activeMs > 60_000) {
            throw new HttpError(400, "durée active invalide");
          }
          deps.gamification.addActiveTime(day, activeMs);
          return json({ ok: true });
        }

        if (request.method === "POST" && pathname === "/api/shutdown") {
          if (!deps.shutdown) throw new HttpError(501, "arrêt non câblé");
          // Différé pour que la réponse parte avant l'arrêt du process.
          setTimeout(deps.shutdown, 25);
          return json({ ok: true });
        }

        if (request.method === "GET" && pathname === "/api/fleet") {
          return json(currentFleet());
        }

        if (request.method === "GET" && pathname === "/api/search") {
          const query = url.searchParams.get("q") ?? "";
          const projectId = url.searchParams.get("projectId") ?? undefined;
          if (projectId && !deps.projects.get(projectId)) throw new HttpError(404, "projet inconnu");
          return json(deps.search.search(query, projectId));
        }

        if (request.method === "GET" && pathname === "/api/memory") {
          return json(deps.memory.list());
        }

        if (request.method === "POST" && pathname === "/api/memory") {
          const body = await readObject(request);
          const path = requiredString(body, "path");
          const content = body.content === undefined ? "" : body.content;
          if (typeof content !== "string") throw new HttpError(400, "contenu mémoire invalide");
          try {
            return json(deps.memory.create(path, content), 201);
          } catch (error) {
            memoryHttpError(error, "création du fichier mémoire impossible");
          }
        }

        const memoryPath = routeId(pathname, /^\/api\/memory\/([^/]+)$/);
        if (request.method === "GET" && memoryPath !== null) {
          try {
            return json(deps.memory.read(memoryPath));
          } catch (error) {
            memoryHttpError(error);
          }
        }
        if (request.method === "PUT" && memoryPath !== null) {
          const body = await readObject(request);
          if (typeof body.content !== "string") throw new HttpError(400, "contenu mémoire invalide");
          try {
            return json(deps.memory.write(memoryPath, body.content));
          } catch (error) {
            memoryHttpError(error);
          }
        }
        if (request.method === "PATCH" && memoryPath !== null) {
          const body = await readObject(request);
          const newPath = requiredString(body, "newPath");
          try {
            return json(deps.memory.rename(memoryPath, newPath));
          } catch (error) {
            memoryHttpError(error, "renommage du fichier mémoire impossible");
          }
        }
        if (request.method === "DELETE" && memoryPath !== null) {
          try {
            deps.memory.delete(memoryPath);
            return empty(204);
          } catch (error) {
            memoryHttpError(error);
          }
        }

        if (request.method === "GET" && pathname === "/api/notifications") {
          const afterRaw = url.searchParams.get("after") ?? "0";
          const after = Number(afterRaw);
          if (!Number.isSafeInteger(after) || after < 0) throw new HttpError(400, "curseur invalide");
          return json(deps.notifications.listAfter(after));
        }

        if (request.method === "GET" && pathname === "/api/notifications/cursor") {
          return json({ cursor: deps.notifications.latestId() });
        }

        if (request.method === "GET" && pathname === "/api/projects") {
          return json(deps.projects.list());
        }

        if (request.method === "POST" && pathname === "/api/projects") {
          const body = await readObject(request);
          const name = requiredString(body, "name");
          const path = requiredString(body, "path");
          if (!existsSync(path)) throw new HttpError(400, "path inexistant");
          let project: ReturnType<ProjectStore["create"]>;
          try {
            project = deps.projects.create({ name, path });
          } catch {
            throw new HttpError(409, "projet déjà existant");
          }
          const appFilesystemScope = deps.settings.get<unknown>("filesystemScope");
          if (FILESYSTEM_SCOPES.includes(appFilesystemScope as FilesystemScope)) {
            deps.projects.setFilesystemScope(project.id, appFilesystemScope as FilesystemScope);
            project = deps.projects.get(project.id)!;
          }
          deps.skills.refresh();
          return json(project, 201);
        }

        if (request.method === "GET" && pathname === "/api/skills") {
          const provider = url.searchParams.get("provider");
          if (provider !== null && provider !== "claude" && provider !== "codex") {
            throw new HttpError(400, "provider de skill invalide");
          }
          return json(deps.skills.list({
            query: url.searchParams.get("q") ?? undefined,
            provider: (provider as SkillProvider | null) ?? undefined,
            projectId: url.searchParams.get("projectId") ?? undefined,
            favoriteProjectId: url.searchParams.get("favoriteProjectId") ?? undefined,
          }));
        }

        if (request.method === "POST" && pathname === "/api/skills/refresh") {
          return json({ count: deps.skills.refresh() });
        }

        if (request.method === "POST" && pathname === "/api/skills/suggestions") {
          const body = await readObject(request);
          const projectId = requiredString(body, "projectId");
          if (!deps.projects.get(projectId)) throw new HttpError(404, "projet inconnu");
          const text = requiredString(body, "text");
          const resolveAmbiguous = optionalBoolean(body, "resolveAmbiguous", false);
          return json(await deps.skillSuggestions.suggest(projectId, text, resolveAmbiguous));
        }

        if (request.method === "POST" && pathname === "/api/skills/generate") {
          const body = await readObject(request);
          const projectId = requiredString(body, "projectId");
          if (!deps.projects.get(projectId)) throw new HttpError(404, "projet inconnu");
          const description = requiredString(body, "description");
          if (body.scope !== "project" && body.scope !== "global") {
            throw new HttpError(400, "portée de skill invalide");
          }
          try {
            return json(await deps.skillComposer.compose({
              projectId,
              description,
              scope: body.scope,
            }), 201);
          } catch (error) {
            if (error instanceof SkillAlreadyExistsError) {
              throw new HttpError(409, error.message);
            }
            throw error;
          }
        }

        const skillId = routeId(pathname, /^\/api\/skills\/([^/]+)$/);
        if (request.method === "GET" && skillId !== null) {
          const skill = deps.skills.get(skillId, url.searchParams.get("projectId") ?? undefined);
          if (!skill) throw new HttpError(404, "skill inconnu");
          return json(skill);
        }

        const projectSkillFavorite = pathname.match(
          /^\/api\/projects\/([^/]+)\/skills\/([^/]+)\/favorite$/,
        );
        if (request.method === "PUT" && projectSkillFavorite) {
          let projectId: string;
          let favoriteSkillId: string;
          try {
            projectId = decodeURIComponent(projectSkillFavorite[1] ?? "");
            favoriteSkillId = decodeURIComponent(projectSkillFavorite[2] ?? "");
          } catch {
            throw new HttpError(400, "identifiant invalide");
          }
          const body = await readObject(request);
          if (typeof body.favorite !== "boolean") {
            throw new HttpError(400, "champ favorite invalide");
          }
          if (!deps.skills.setFavorite(projectId, favoriteSkillId, body.favorite)) {
            throw new HttpError(404, "projet ou skill inconnu");
          }
          return empty(204);
        }

        const projectGitDiffId = routeId(
          pathname,
          /^\/api\/projects\/([^/]+)\/git\/diff$/,
        );
        if (request.method === "GET" && projectGitDiffId !== null) {
          if (!deps.projects.get(projectGitDiffId)) {
            throw new HttpError(404, "projet inconnu");
          }
          const base = url.searchParams.get("base");
          const head = url.searchParams.get("head");
          const conversationId = url.searchParams.get("conversationId");
          const conversation = conversationId ? deps.conversations.get(conversationId) : null;
          if (conversationId && (!conversation || conversation.project_id !== projectGitDiffId)) {
            throw new HttpError(404, "conversation inconnue pour ce projet");
          }
          if (!base || !head) throw new HttpError(400, "références Git manquantes");
          try {
            return json(await deps.git.diff(
              projectGitDiffId,
              base,
              head,
              conversation?.worktree_path,
            ));
          } catch (error) {
            if (error instanceof GitProjectError) throw new HttpError(400, error.message);
            throw error;
          }
        }

        const projectGitWorkingTreeDiffId = routeId(
          pathname,
          /^\/api\/projects\/([^/]+)\/git\/working-tree-diff$/,
        );
        if (request.method === "GET" && projectGitWorkingTreeDiffId !== null) {
          if (!deps.projects.get(projectGitWorkingTreeDiffId)) {
            throw new HttpError(404, "projet inconnu");
          }
          const conversationId = url.searchParams.get("conversationId");
          const conversation = conversationId ? deps.conversations.get(conversationId) : null;
          if (conversationId && (!conversation || conversation.project_id !== projectGitWorkingTreeDiffId)) {
            throw new HttpError(404, "conversation inconnue pour ce projet");
          }
          try {
            return json(await deps.git.workingTreeDiff(
              projectGitWorkingTreeDiffId,
              conversation?.worktree_path,
            ));
          } catch (error) {
            if (error instanceof GitProjectError) throw new HttpError(400, error.message);
            throw error;
          }
        }

        const projectGitFileId = routeId(
          pathname,
          /^\/api\/projects\/([^/]+)\/git\/file$/,
        );
        if (request.method === "GET" && projectGitFileId !== null) {
          if (!deps.projects.get(projectGitFileId)) throw new HttpError(404, "projet inconnu");
          const path = url.searchParams.get("path");
          const ref = url.searchParams.get("ref") ?? "worktree";
          const conversationId = url.searchParams.get("conversationId");
          const conversation = conversationId ? deps.conversations.get(conversationId) : null;
          if (conversationId && (!conversation || conversation.project_id !== projectGitFileId)) {
            throw new HttpError(404, "conversation inconnue pour ce projet");
          }
          if (!path) throw new HttpError(400, "chemin de fichier manquant");
          try {
            return json(deps.git.file(
              projectGitFileId,
              path,
              ref,
              conversation?.worktree_path,
            ));
          } catch (error) {
            if (error instanceof GitProjectError) throw new HttpError(400, error.message);
            throw error;
          }
        }

        const projectGitCommitId = routeId(
          pathname,
          /^\/api\/projects\/([^/]+)\/git\/commit$/,
        );
        if (request.method === "POST" && projectGitCommitId !== null) {
          if (!deps.projects.get(projectGitCommitId)) throw new HttpError(404, "projet inconnu");
          const body = await readObject(request);
          const conversationId = requiredString(body, "conversationId");
          const conversation = deps.conversations.get(conversationId);
          if (!conversation || conversation.project_id !== projectGitCommitId) {
            throw new HttpError(404, "conversation inconnue pour ce projet");
          }
          const paths = body.paths;
          if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string")) {
            throw new HttpError(400, "fichiers sélectionnés invalides");
          }
          const message = requiredString(body, "message");
          try {
            return json(deps.git.commit(
              projectGitCommitId,
              conversation.worktree_path,
              paths as string[],
              message,
              conversationId,
            ), 201);
          } catch (error) {
            if (error instanceof GitProjectError) throw new HttpError(409, error.message);
            throw error;
          }
        }

        const projectGitId = routeId(pathname, /^\/api\/projects\/([^/]+)\/git$/);
        if (request.method === "GET" && projectGitId !== null) {
          if (!deps.projects.get(projectGitId)) throw new HttpError(404, "projet inconnu");
          const conversationId = url.searchParams.get("conversationId");
          const conversation = conversationId ? deps.conversations.get(conversationId) : null;
          if (conversationId && (!conversation || conversation.project_id !== projectGitId)) {
            throw new HttpError(404, "conversation inconnue pour ce projet");
          }
          try {
            return json(deps.git.snapshot(projectGitId, conversation?.worktree_path));
          } catch (error) {
            if (error instanceof GitProjectError) throw new HttpError(400, error.message);
            throw error;
          }
        }

        // Worktrees : `GET` liste ceux que la fusion rend jetables, `DELETE`
        // en retire un. La création passe par POST /api/conversations, parce
        // qu'un worktree n'existe que pour porter une conversation.
        const projectWorktreesId = routeId(
          pathname,
          /^\/api\/projects\/([^/]+)\/worktrees$/,
        );
        if (projectWorktreesId !== null) {
          if (!deps.projects.get(projectWorktreesId)) throw new HttpError(404, "projet inconnu");
          try {
            if (request.method === "GET") {
              return json({
                worktrees: deps.git.snapshot(projectWorktreesId).worktrees,
                merged: deps.git.mergedWorktrees(projectWorktreesId),
              });
            }
            if (request.method === "DELETE") {
              const body = await readObject(request);
              deps.git.removeWorktree(projectWorktreesId, requiredString(body, "path"));
              return json({ ok: true });
            }
          } catch (error) {
            if (error instanceof GitProjectError) throw new HttpError(409, error.message);
            throw error;
          }
        }

        const projectIntegrationsId = routeId(
          pathname,
          /^\/api\/projects\/([^/]+)\/integrations$/,
        );
        if (request.method === "GET" && projectIntegrationsId !== null) {
          if (!deps.projects.get(projectIntegrationsId)) throw new HttpError(404, "projet inconnu");
          return json(dashboardPayload(projectIntegrationsId, deps.integrations, deps.tickets).integrations);
        }

        const projectIntegrationMatch = pathname.match(
          /^\/api\/projects\/([^/]+)\/integrations\/(clickup|gitlab|github|notion|sentry)$/,
        );
        if (projectIntegrationMatch && (request.method === "PUT" || request.method === "DELETE")) {
          const projectId = decodeURIComponent(projectIntegrationMatch[1]!);
          const type = projectIntegrationMatch[2] as IntegrationType;
          if (!deps.projects.get(projectId)) throw new HttpError(404, "projet inconnu");

          if (request.method === "DELETE") {
            const existing = deps.integrations.find(projectId, type);
            if (existing) deps.integrations.remove(existing.id);
            broadcastDashboard(projectId);
            return empty(204);
          }

          const body = await readObject(request);
          const config = body.config;
          if (typeof config !== "object" || config === null || Array.isArray(config)) {
            throw new HttpError(400, "champ config invalide");
          }
          const branchPattern = optionalTrimmed(body, "branchPattern");
          try {
            const saved = deps.integrations.upsert(projectId, type, {
              config: config as Record<string, unknown>,
              branchPattern,
            });
            broadcastDashboard(projectId);
            void deps.integrationsRefresher.refreshProject(projectId).catch(() => {});
            const { snapshot: _snapshot, ...rest } = saved;
            return json(rest);
          } catch (error) {
            throw new HttpError(
              400,
              error instanceof Error
                ? `motif de branche invalide : ${error.message}`
                : "intégration invalide",
            );
          }
        }

        const projectDashboardId = routeId(pathname, /^\/api\/projects\/([^/]+)\/dashboard$/);
        if (request.method === "GET" && projectDashboardId !== null) {
          if (!deps.projects.get(projectDashboardId)) throw new HttpError(404, "projet inconnu");
          return json(dashboardPayload(projectDashboardId, deps.integrations, deps.tickets));
        }

        const projectDashboardRefreshId = routeId(
          pathname,
          /^\/api\/projects\/([^/]+)\/dashboard\/refresh$/,
        );
        if (request.method === "POST" && projectDashboardRefreshId !== null) {
          if (!deps.projects.get(projectDashboardRefreshId)) throw new HttpError(404, "projet inconnu");
          void deps.integrationsRefresher.refreshProject(projectDashboardRefreshId).catch(() => {});
          return empty(202);
        }

        const projectDefaultPresetId = routeId(
          pathname,
          /^\/api\/projects\/([^/]+)\/default-preset$/,
        );
        if (request.method === "PUT" && projectDefaultPresetId !== null) {
          if (!deps.projects.get(projectDefaultPresetId)) {
            throw new HttpError(404, "projet inconnu");
          }
          const body = await readObject(request);
          const presetId = body.presetId;
          if (presetId !== null && typeof presetId !== "string") {
            throw new HttpError(400, "champ presetId invalide");
          }
          if (typeof presetId === "string" && !deps.presets.get(presetId)) {
            throw new HttpError(404, "preset inconnu");
          }
          deps.projects.setDefaultPreset(projectDefaultPresetId, presetId as string | null);
          const preset = typeof presetId === "string" ? deps.presets.get(presetId) : null;
          // Une permission absente signifie « hériter du projet » : ne pas
          // réinitialiser le choix existant quand un preset sans override devient
          // le défaut. Une permission explicite devient le mode du projet, ce
          // qui conserve le chemin d'exécution actuel sans toucher au contrat
          // des conversations.
          if (preset?.permission_mode) {
            deps.projects.setPermissionMode(projectDefaultPresetId, preset.permission_mode);
          }
          return json(deps.projects.get(projectDefaultPresetId));
        }

        const projectDefaultReviewPresetId = routeId(
          pathname,
          /^\/api\/projects\/([^/]+)\/default-review-preset$/,
        );
        if (request.method === "PUT" && projectDefaultReviewPresetId !== null) {
          if (!deps.projects.get(projectDefaultReviewPresetId)) {
            throw new HttpError(404, "projet inconnu");
          }
          const body = await readObject(request);
          const presetId = body.presetId;
          if (presetId !== null && typeof presetId !== "string") {
            throw new HttpError(400, "champ presetId invalide");
          }
          if (typeof presetId === "string" && !deps.presets.get(presetId)) {
            throw new HttpError(404, "preset inconnu");
          }
          deps.projects.setDefaultReviewPreset(projectDefaultReviewPresetId, presetId as string | null);
          return json(deps.projects.get(projectDefaultReviewPresetId));
        }

        const projectDefaultCorrectionPresetId = routeId(
          pathname,
          /^\/api\/projects\/([^/]+)\/default-correction-preset$/,
        );
        if (request.method === "PUT" && projectDefaultCorrectionPresetId !== null) {
          if (!deps.projects.get(projectDefaultCorrectionPresetId)) {
            throw new HttpError(404, "projet inconnu");
          }
          const body = await readObject(request);
          const presetId = body.presetId;
          if (presetId !== null && typeof presetId !== "string") {
            throw new HttpError(400, "champ presetId invalide");
          }
          if (typeof presetId === "string" && !deps.presets.get(presetId)) {
            throw new HttpError(404, "preset inconnu");
          }
          deps.projects.setDefaultCorrectionPreset(projectDefaultCorrectionPresetId, presetId as string | null);
          return json(deps.projects.get(projectDefaultCorrectionPresetId));
        }

        const projectFilesystemScopeId = routeId(
          pathname,
          /^\/api\/projects\/([^/]+)\/filesystem-scope$/,
        );
        if (request.method === "PUT" && projectFilesystemScopeId !== null) {
          if (!deps.projects.get(projectFilesystemScopeId)) {
            throw new HttpError(404, "projet inconnu");
          }
          const body = await readObject(request);
          if (!FILESYSTEM_SCOPES.includes(body.scope as FilesystemScope)) {
            throw new HttpError(400, "portée filesystem invalide");
          }
          deps.projects.setFilesystemScope(
            projectFilesystemScopeId,
            body.scope as FilesystemScope,
          );
          return json(deps.projects.get(projectFilesystemScopeId));
        }

        const projectAutoRescanId = routeId(
          pathname,
          /^\/api\/projects\/([^/]+)\/auto-rescan$/,
        );
        if (request.method === "PUT" && projectAutoRescanId !== null) {
          if (!deps.projects.get(projectAutoRescanId)) throw new HttpError(404, "projet inconnu");
          const body = await readObject(request);
          if (typeof body.enabled !== "boolean") {
            throw new HttpError(400, "option de rescan automatique invalide");
          }
          deps.projects.setAutoRescan(projectAutoRescanId, body.enabled);
          return json(deps.projects.get(projectAutoRescanId));
        }

        const projectPinId = routeId(
          pathname,
          /^\/api\/projects\/([^/]+)\/pin$/,
        );
        if (request.method === "POST" && projectPinId !== null) {
          if (!deps.projects.get(projectPinId)) {
            throw new HttpError(404, "projet inconnu");
          }
          const body = await readObject(request);
          deps.projects.setPinned(projectPinId, requiredPinned(body));
          return empty(204);
        }

        const projectConversationsId = routeId(
          pathname,
          /^\/api\/projects\/([^/]+)\/conversations$/,
        );
        if (request.method === "GET" && projectConversationsId !== null) {
          if (!deps.projects.get(projectConversationsId)) {
            throw new HttpError(404, "projet inconnu");
          }
          const scope = url.searchParams.get("scope") ?? "active";
          if (scope !== "active" && scope !== "archived" && scope !== "trash") {
            throw new HttpError(400, "portée de conversations invalide");
          }
          return json(deps.conversations.listByProject(projectConversationsId, scope));
        }

        const projectCostsId = routeId(pathname, /^\/api\/projects\/([^/]+)\/costs$/);
        if (request.method === "GET" && projectCostsId !== null) {
          if (!deps.projects.get(projectCostsId)) throw new HttpError(404, "projet inconnu");
          const month = url.searchParams.get("month") ?? new Date().toISOString().slice(0, 7);
          try {
            return json(deps.costs.projectMonth(projectCostsId, month));
          } catch {
            throw new HttpError(400, "mois invalide");
          }
        }

        const projectMcpMeasureId = routeId(
          pathname,
          /^\/api\/projects\/([^/]+)\/mcp-servers\/measure$/,
        );
        if (request.method === "POST" && projectMcpMeasureId !== null) {
          const project = deps.projects.get(projectMcpMeasureId);
          if (!project) throw new HttpError(404, "projet inconnu");
          // Lancer une dizaine de process est lent : le résultat est mis en
          // cache et ne se rejoue que sur demande explicite de l'utilisateur.
          // Les deux providers : un serveur Codex pèse dans la fenêtre autant
          // qu'un serveur Claude, et le nom suffit à les distinguer.
          const weights = await measureMcpServers({
            ...codexServerDefinitions(),
            ...claudeServerDefinitions(project.path),
          });
          const cache = (deps.settings.get<Record<string, unknown>>("mcpWeights")) ?? {};
          for (const weight of weights) {
            if (weight.tokens !== null) cache[weight.name] = weight;
          }
          deps.settings.set("mcpWeights", cache);
          return json(weights);
        }

        const projectProfileId = routeId(
          pathname,
          /^\/api\/projects\/([^/]+)\/context-profile$/,
        );
        if (request.method === "GET" && projectProfileId !== null) {
          const project = deps.projects.get(projectProfileId);
          if (!project) throw new HttpError(404, "projet inconnu");
          let weights = deps.settings.get<Record<string, McpServerWeight>>("mcpWeights") ?? {};
          // Seuls les serveurs effectivement chargés comptent : un serveur
          // décoché ne pèse plus rien dans la fenêtre.
          const loaded = project.mcp_servers
            ?? listMcpServers(project.path).map((server) => server.name);
          // Première consultation : on pèse les serveurs une fois plutôt que
          // d'afficher zéro et d'attendre une action manuelle que rien
          // n'annonce. Les fois suivantes viennent du cache.
          if (loaded.some((name) => weights[name] === undefined)) {
            const measured = await measureMcpServers({
              ...codexServerDefinitions(),
              ...claudeServerDefinitions(project.path),
            });
            weights = { ...weights };
            for (const weight of measured) {
              if (weight.tokens !== null) weights[weight.name] = weight;
            }
            deps.settings.set("mcpWeights", weights);
          }
          const mcpTokens = loaded.reduce(
            (sum, name) => sum + (weights[name]?.tokens ?? 0),
            0,
          );
          return json({
            instructionsTokens: instructionsTokens(project.path),
            mcpTokens,
          });
        }

        const projectMcpVerifyId = routeId(
          pathname,
          /^\/api\/projects\/([^/]+)\/mcp-servers\/verify$/,
        );
        if (request.method === "POST" && projectMcpVerifyId !== null) {
          const project = deps.projects.get(projectMcpVerifyId);
          if (!project) throw new HttpError(404, "projet inconnu");
          // Vérité terrain : deux tours CLI minimaux, avec et sans les serveurs
          // retenus. Coûteux, donc jamais automatique.
          const available = claudeServerDefinitions(project.path);
          const selected = project.mcp_servers === null
            ? available
            : Object.fromEntries(
              project.mcp_servers
                .filter((name) => name in available)
                .map((name) => [name, available[name]]),
            );
          const probe = await verifyMcpContextCost(project.path, selected);
          // `without` est le contexte d'un tour à vide : c'est la charge fixe
          // réelle, que la jauge affichera au lieu de la déduire.
          if (!probe.error) deps.settings.set("contextBaseline", probe.without);
          return json(probe);
        }

        const projectMcpId = routeId(pathname, /^\/api\/projects\/([^/]+)\/mcp-servers$/);
        if (projectMcpId !== null) {
          const project = deps.projects.get(projectMcpId);
          if (!project) throw new HttpError(404, "projet inconnu");
          if (request.method === "GET") {
            // Noms seulement : les fichiers de config contiennent des clés d'API.
            return json({
              servers: listMcpServers(project.path),
              enabled: project.mcp_servers,
              weights: deps.settings.get<Record<string, McpServerWeight>>("mcpWeights") ?? {},
              used: usedMcpServers(deps.conversations.toolNamesByProject(projectMcpId)),
            });
          }
          if (request.method === "PUT") {
            const body = await readObject(request);
            const enabled = body.enabled;
            if (enabled !== null && !Array.isArray(enabled)) {
              throw new HttpError(400, "sélection MCP invalide");
            }
            deps.projects.setMcpServers(
              projectMcpId,
              enabled === null
                ? null
                : enabled.filter((name): name is string => typeof name === "string"),
            );
            return json({
              servers: listMcpServers(project.path),
              enabled: deps.projects.get(projectMcpId)?.mcp_servers ?? null,
              weights: deps.settings.get<Record<string, McpServerWeight>>("mcpWeights") ?? {},
              used: usedMcpServers(deps.conversations.toolNamesByProject(projectMcpId)),
            });
          }
        }

        const projectWorkflowsId = routeId(
          pathname,
          /^\/api\/projects\/([^/]+)\/workflows$/,
        );
        if (request.method === "GET" && projectWorkflowsId !== null) {
          if (!deps.projects.get(projectWorkflowsId)) throw new HttpError(404, "projet inconnu");
          return json(deps.workflows.listByProject(projectWorkflowsId));
        }

        if (request.method === "POST" && pathname === "/api/workflows") {
          const body = await readObject(request);
          const projectId = requiredString(body, "projectId");
          if (!deps.projects.get(projectId)) throw new HttpError(404, "projet inconnu");
          try {
            return json(deps.workflows.create(workflowInput(body, projectId, deps)), 201);
          } catch (error) {
            if (error instanceof HttpError) throw error;
            throw new HttpError(409, "nom de workflow déjà utilisé");
          }
        }

        const workflowRunId = routeId(pathname, /^\/api\/workflows\/([^/]+)\/run$/);
        if (request.method === "POST" && workflowRunId !== null) {
          const workflow = deps.workflows.get(workflowRunId);
          if (!workflow) throw new HttpError(404, "workflow inconnu");
          const preset = workflow.preset_id ? deps.presets.get(workflow.preset_id) : null;
          const config = preset ?? workflow;
          const invocation = `$${workflow.skill_invocation}`;
          const message = workflow.prompt.includes(invocation)
            ? workflow.prompt
            : `${invocation}\n\n${workflow.prompt}`;
          const snapshot = deps.git.snapshot(workflow.project_id);
          const conversation = deps.conversations.create({
            projectId: workflow.project_id,
            provider: config.provider,
            model: config.model,
            presetId: workflow.preset_id,
            effort: config.effort,
            speed: config.speed,
            orchestrator: config.orchestrator,
            subagentPresetId: "subagent_preset_id" in config ? config.subagent_preset_id : null,
            subagentEffort: "subagent_effort" in config ? config.subagent_effort : null,
            createdOnBranch: snapshot.currentBranch,
            firstMessage: message,
          });
          void deps.runner.runTurn(conversation.id, message, [])
            .catch((error) => console.error("Échec du workflow", error));
          return json(conversation, 201);
        }

        const workflowId = routeId(pathname, /^\/api\/workflows\/([^/]+)$/);
        if (request.method === "PUT" && workflowId !== null) {
          const workflow = deps.workflows.get(workflowId);
          if (!workflow) throw new HttpError(404, "workflow inconnu");
          const body = await readObject(request);
          try {
            return json(deps.workflows.update(
              workflowId,
              workflowInput(body, workflow.project_id, deps),
            ));
          } catch (error) {
            if (error instanceof HttpError) throw error;
            throw new HttpError(409, "nom de workflow déjà utilisé");
          }
        }

        if (request.method === "DELETE" && workflowId !== null) {
          if (deps.routineStore.countByWorkflow(workflowId) > 0) {
            throw new HttpError(409, "workflow utilisé par une routine");
          }
          if (!deps.workflows.delete(workflowId)) throw new HttpError(404, "workflow inconnu");
          return empty(204);
        }

        if (request.method === "GET" && pathname === "/api/routines") {
          const projectId = url.searchParams.get("projectId") ?? undefined;
          if (projectId && !deps.projects.get(projectId)) throw new HttpError(404, "projet inconnu");
          return json(deps.routineStore.list(projectId));
        }

        if (request.method === "POST" && pathname === "/api/routines") {
          const body = await readObject(request);
          const projectId = requiredString(body, "projectId");
          if (!deps.projects.get(projectId)) throw new HttpError(404, "projet inconnu");
          try {
            return json(deps.routineStore.save(routineInput(body, projectId, deps, true)), 201);
          } catch (error) {
            if (error instanceof HttpError) throw error;
            if (error instanceof Error && error.message.includes("cron")) {
              throw new HttpError(400, error.message);
            }
            throw new HttpError(409, "nom de routine déjà utilisé");
          }
        }

        const routineRunsId = routeId(pathname, /^\/api\/routines\/([^/]+)\/runs$/);
        if (request.method === "GET" && routineRunsId !== null) {
          if (!deps.routineStore.get(routineRunsId)) throw new HttpError(404, "routine inconnue");
          return json(deps.routineStore.runs(routineRunsId));
        }

        const routineRunNowId = routeId(pathname, /^\/api\/routines\/([^/]+)\/run$/);
        if (request.method === "POST" && routineRunNowId !== null) {
          const run = deps.routines.runNow(routineRunNowId);
          if (!run) throw new HttpError(404, "routine inconnue");
          return json(run, 201);
        }

        const routineId = routeId(pathname, /^\/api\/routines\/([^/]+)$/);
        if (request.method === "PUT" && routineId !== null) {
          const routine = deps.routineStore.get(routineId);
          if (!routine) throw new HttpError(404, "routine inconnue");
          const body = await readObject(request);
          try {
            return json(deps.routineStore.save(
              routineInput(body, routine.project_id, deps, routine.enabled),
              routine.id,
            ));
          } catch (error) {
            if (error instanceof HttpError) throw error;
            if (error instanceof Error && error.message.includes("cron")) {
              throw new HttpError(400, error.message);
            }
            throw new HttpError(409, "nom de routine déjà utilisé");
          }
        }

        if (request.method === "DELETE" && routineId !== null) {
          if (!deps.routineStore.delete(routineId)) throw new HttpError(404, "routine inconnue");
          return empty(204);
        }

        if (request.method === "GET" && pathname === "/api/presets") {
          return json(deps.presets.list());
        }

        if (request.method === "POST" && pathname === "/api/presets") {
          const body = await readObject(request);
          const input = presetInput(body);
          validatePresetSubagentConfig(input, deps);
          try {
            return json(deps.presets.create(input), 201);
          } catch {
            throw new HttpError(409, "nom de preset déjà utilisé");
          }
        }

        const presetId = routeId(pathname, /^\/api\/presets\/([^/]+)$/);
        if (request.method === "PUT" && presetId !== null) {
          const body = await readObject(request);
          const input = presetInput(body);
          validatePresetSubagentConfig(input, deps);
          try {
            const preset = deps.presets.update(presetId, input);
            if (!preset) throw new HttpError(404, "preset inconnu");
            return json(preset);
          } catch (error) {
            if (error instanceof HttpError) throw error;
            throw new HttpError(409, "nom de preset déjà utilisé");
          }
        }

        const restoredPresetId = routeId(pathname, /^\/api\/presets\/([^/]+)\/restore$/);
        if (request.method === "POST" && restoredPresetId !== null) {
          try {
            const preset = deps.presets.restore(restoredPresetId);
            if (!preset) throw new HttpError(404, "preset inconnu");
            return json(preset);
          } catch (error) {
            if (error instanceof HttpError) throw error;
            if (error instanceof Error && error.message === "preset sans valeurs d'origine") {
              throw new HttpError(409, error.message);
            }
            throw new HttpError(409, "nom de preset déjà utilisé");
          }
        }

        if (request.method === "DELETE" && presetId !== null) {
          try {
            if (!deps.presets.delete(presetId)) {
              throw new HttpError(404, "preset inconnu");
            }
            return empty(204);
          } catch (error) {
            if (error instanceof HttpError) throw error;
            throw new HttpError(409, "preset intégré non supprimable");
          }
        }

        if (request.method === "GET" && pathname === "/api/settings") {
          // Lecture seule, calculée : l'UI en a besoin pour isoler le coût du
          // bridge conductor dans la jauge de contexte.
          return json(publicSettings(deps));
        }

        if (request.method === "PUT" && pathname === "/api/settings") {
          const body = await readObject(request);
          let updated = false;
          if ("quotaThresholds" in body) {
            deps.settings.set("quotaThresholds", quotaThresholds(body));
            updated = true;
          }
          if ("longTaskThresholdSeconds" in body) {
            const threshold = body.longTaskThresholdSeconds;
            if (
              typeof threshold !== "number"
              || !Number.isFinite(threshold)
              || !Number.isInteger(threshold)
              || threshold < 10
              || threshold > 86_400
            ) throw new HttpError(400, "seuil de tâche longue invalide");
            deps.settings.set("longTaskThresholdSeconds", threshold);
            updated = true;
          }
          if ("designLastUrl" in body) {
            // `null` efface la reprise et fait repartir la webview de l'accueil.
            if (body.designLastUrl === null) {
              deps.settings.set("designLastUrl", null);
            } else if (!isResumableDesignUrl(body.designLastUrl)) {
              throw new HttpError(400, "URL Claude Design invalide");
            } else {
              deps.settings.set("designLastUrl", body.designLastUrl);
            }
            updated = true;
          }
          if ("filesystemScope" in body) {
            if (!FILESYSTEM_SCOPES.includes(body.filesystemScope as FilesystemScope)) {
              throw new HttpError(400, "portée filesystem invalide");
            }
            deps.settings.set("filesystemScope", body.filesystemScope);
            updated = true;
          }
          if ("actionFormat" in body) {
            // Normalisé côté serveur : un intitulé vide ou une liste absente
            // retombe sur les défauts au lieu de désactiver la détection.
            deps.settings.set("actionFormat", actionFormat(body.actionFormat));
            updated = true;
          }
          if (INTEGRATION_TOKENS_KEY in body) {
            const tokens = body[INTEGRATION_TOKENS_KEY];
            if (typeof tokens !== "object" || tokens === null || Array.isArray(tokens)) {
              throw new HttpError(400, "integrationTokens invalide");
            }
            const currentTokens = deps.settings.get<Record<string, string>>(INTEGRATION_TOKENS_KEY) ?? {};
            for (const [name, value] of Object.entries(tokens as Record<string, unknown>)) {
              if (name !== "clickup" && name !== "gitlab") {
                throw new HttpError(400, `token ${name} inconnu`);
              }
              if (value === null || value === "") {
                delete currentTokens[name];
              } else if (typeof value === "string") {
                currentTokens[name] = value;
              } else {
                throw new HttpError(400, `token ${name} invalide`);
              }
            }
            deps.settings.set(INTEGRATION_TOKENS_KEY, currentTokens);
            updated = true;
          }
          if (!updated) throw new HttpError(400, "aucun réglage reconnu");
          return json(publicSettings(deps));
        }

        const ticketNotesId = routeId(pathname, /^\/api\/tickets\/([^/]+)\/notes$/);
        if (ticketNotesId !== null && (request.method === "GET" || request.method === "POST")) {
          const ticket = deps.tickets.get(ticketNotesId);
          if (!ticket) throw new HttpError(404, "ticket inconnu");
          if (request.method === "GET") {
            return json(deps.tickets.notesByTicket(ticket.id));
          }
          const body = await readObject(request);
          const note = deps.tickets.addNote(ticket.id, requiredString(body, "body").trim());
          broadcastDashboard(ticket.project_id);
          return json(note, 201);
        }

        const ticketNoteId = routeId(pathname, /^\/api\/ticket-notes\/([^/]+)$/);
        if (request.method === "DELETE" && ticketNoteId !== null) {
          const deleted = deps.tickets.deleteNote(ticketNoteId);
          if (!deleted) throw new HttpError(404, "note inconnue");
          const ticket = deps.tickets.get(deleted.ticket_id);
          if (ticket) broadcastDashboard(ticket.project_id);
          return empty(204);
        }

        if (request.method === "POST" && pathname === "/api/conversations") {
          const body = await readObject(request);
          const projectId = requiredString(body, "projectId");
          if (!deps.projects.get(projectId)) {
            throw new HttpError(404, "projet inconnu");
          }
          const provider = requiredString(body, "provider");
          if (provider !== "claude" && provider !== "codex") {
            throw new HttpError(400, "provider invalide");
          }
          const model = requiredString(body, "model");
          const effort = optionalEffort(body, provider as Provider);
          const speed = optionalSpeed(body, provider as Provider);
          const permissionMode = optionalPresetPermissionMode(body);
          const requestedPresetId = optionalNamedPresetId(body, "presetId");
          const presetId = requestedPresetId ?? inferPresetId({
            provider: provider as Provider,
            model,
            effort,
            speed,
            orchestrator: optionalBoolean(body, "orchestrator", true),
          }, deps);
          if (presetId !== null && !deps.presets.get(presetId)) {
            throw new HttpError(404, "preset inconnu");
          }
          const { message, images, attachments } = messageWithAttachments(body, deps.media);
          // Défaut ON : une conversation peut déléguer sauf mention contraire.
          const orchestrator = optionalBoolean(body, "orchestrator", true);
          const { subagentPresetId, subagentEffort } = conversationSubagentConfig(body, deps);
          // Une conversation peut naître sur sa propre branche : Pupitre lui
          // crée alors un worktree, où tous ses agents travailleront (ADR 0001).
          const branch = optionalTrimmed(body, "branch");
          const ticketId = optionalTrimmed(body, "ticketId");
          let ticket = ticketId ? deps.tickets.get(ticketId) : null;
          if (ticketId && (!ticket || ticket.project_id !== projectId)) {
            throw new HttpError(404, "ticket inconnu");
          }
          let effectiveBranch = branch ?? (ticket ? deps.tickets.branchesOf(ticket.id)[0] ?? null : null);
          if (!ticket && effectiveBranch) {
            const patternSource = deps.integrations.listByProject(projectId)
              .find((integration) => integration.branch_pattern)?.branch_pattern ?? null;
            const pattern = patternSource ? compileBranchPattern(patternSource) : null;
            const key = extractTicketKey(effectiveBranch, pattern);
            ticket = key ? deps.tickets.findByKey(projectId, key) : null;
          }
          let worktreePath: string | null = null;
          if (effectiveBranch !== null) {
            try {
              worktreePath = deps.git.createWorktree(projectId, { branch: effectiveBranch }).path;
            } catch (error) {
              throw new HttpError(
                400,
                error instanceof Error ? error.message : "worktree impossible",
              );
            }
          }
          const snapshot = deps.git.snapshot(projectId);
          const conversation = deps.conversations.create({
            worktreePath,
            projectId,
            provider: provider as Provider,
            model,
            presetId,
            effort,
            speed,
            permissionMode,
            orchestrator,
            subagentPresetId,
            subagentEffort,
            createdOnBranch: snapshot.currentBranch,
            ticketId: ticket?.id ?? null,
            firstMessage: message.trim() || "Image jointe",
          });
          const preamble = ticket
            ? await ticketBriefFor(deps, ticket, conversation.id)
            : undefined;
          void deps.runner.runTurn(
            conversation.id,
            message,
            images,
            attachments,
            preamble ? { preamble } : {},
          )
            .catch((error) => console.error("Échec du tour", error));
          return json(conversation, 201);
        }

        const conversationModelId = routeId(
          pathname,
          /^\/api\/conversations\/([^/]+)\/model$/,
        );
        if (request.method === "PUT" && conversationModelId !== null) {
          const conversation = deps.conversations.get(conversationModelId);
          if (!conversation) throw new HttpError(404, "conversation inconnue");
          if (deps.runner.activity.isBusy(conversationModelId)) {
            throw new HttpError(409, "un tour est déjà en cours");
          }
          const releaseActivity = deps.runner.activity.acquire(
            conversationModelId,
            "model-change",
          );
          try {
            const body = await readObject(request);
            const provider = requiredString(body, "provider");
            if (provider !== "claude" && provider !== "codex") {
              throw new HttpError(400, "provider invalide");
            }
            if (provider !== conversation.provider) {
              throw new HttpError(409, "un changement de provider exige une passation");
            }
            const model = requiredString(body, "model");
            const effort = optionalEffort(body, conversation.provider);
            const speed = optionalSpeed(body, conversation.provider);
            const estimatedReingestionTokens = deps.conversations.usageTokens(
              conversationModelId,
            );
            deps.conversations.updateModel(conversationModelId, { model, effort, speed });
            return json({
              conversation: deps.conversations.get(conversationModelId),
              estimatedReingestionTokens,
            });
          } finally {
            releaseActivity();
          }
        }

        const conversationPermissionId = routeId(
          pathname,
          /^\/api\/conversations\/([^/]+)\/permission-mode$/,
        );
        if (request.method === "PUT" && conversationPermissionId !== null) {
          const conversation = deps.conversations.get(conversationPermissionId);
          if (!conversation) throw new HttpError(404, "conversation inconnue");
          if (deps.runner.activity.isBusy(conversationPermissionId)) {
            throw new HttpError(409, "un tour est déjà en cours");
          }
          const body = await readObject(request);
          const permissionMode = optionalPresetPermissionMode(body);
          if (permissionMode === undefined) {
            throw new HttpError(400, "permission_mode manquant");
          }
          return json(deps.conversations.setPermissionMode(conversationPermissionId, permissionMode));
        }

        const conversationReadId = routeId(
          pathname,
          /^\/api\/conversations\/([^/]+)\/read$/,
        );
        if (request.method === "POST" && conversationReadId !== null) {
          if (!deps.conversations.get(conversationReadId)) {
            throw new HttpError(404, "conversation inconnue");
          }
          const body = await readObject(request);
          const lastReadTurn = body.lastReadTurn;
          if (
            typeof lastReadTurn !== "number"
            || !Number.isInteger(lastReadTurn)
            || lastReadTurn < 0
          ) {
            throw new HttpError(400, "lastReadTurn invalide");
          }
          return json(deps.conversations.markRead(conversationReadId, lastReadTurn));
        }

        const conversationDebriefId = routeId(
          pathname,
          /^\/api\/conversations\/([^/]+)\/debrief$/,
        );
        if (request.method === "POST" && conversationDebriefId !== null) {
          if (!deps.conversations.get(conversationDebriefId)) {
            throw new HttpError(404, "conversation inconnue");
          }
          if (deps.runner.activity.isBusy(conversationDebriefId)) {
            throw new HttpError(409, "un tour est déjà en cours");
          }
          try {
            return json(await deps.debriefs.generate(conversationDebriefId), 201);
          } catch (error) {
            if (
              error instanceof DebriefAlreadyRunningError
              || error instanceof NoNewDebriefEventsError
            ) {
              throw new HttpError(409, error.message);
            }
            throw new HttpError(
              502,
              error instanceof Error ? error.message : "échec du débrief",
            );
          }
        }

        const conversationSessionSummaryId = routeId(
          pathname,
          /^\/api\/conversations\/([^/]+)\/session-summary$/,
        );
        if (request.method === "POST" && conversationSessionSummaryId !== null) {
          if (!deps.conversations.get(conversationSessionSummaryId)) {
            throw new HttpError(404, "conversation inconnue");
          }
          if (deps.runner.activity.isBusy(conversationSessionSummaryId)) {
            throw new HttpError(409, "un tour est déjà en cours");
          }
          try {
            return json(
              await deps.debriefs.generateSessionSummary(conversationSessionSummaryId),
              201,
            );
          } catch (error) {
            if (
              error instanceof DebriefAlreadyRunningError
              || error instanceof NoNewSessionSummaryEventsError
            ) {
              throw new HttpError(409, error.message);
            }
            throw new HttpError(
              502,
              error instanceof Error ? error.message : "échec du résumé de session",
            );
          }
        }

        const conversationTestInventoryId = routeId(
          pathname,
          /^\/api\/conversations\/([^/]+)\/test-inventory$/,
        );
        if (request.method === "POST" && conversationTestInventoryId !== null) {
          if (!deps.conversations.get(conversationTestInventoryId)) {
            throw new HttpError(404, "conversation inconnue");
          }
          try {
            return json(await deps.testers.inventory(conversationTestInventoryId), 201);
          } catch (error) {
            if (error instanceof TesterBusyError) throw new HttpError(409, error.message);
            throw new HttpError(
              502,
              error instanceof Error ? error.message : "échec de l'inventaire de test",
            );
          }
        }

        const testInventoryId = routeId(pathname, /^\/api\/test-inventories\/([^/]+)$/);
        if (request.method === "GET" && testInventoryId !== null) {
          const inventory = deps.testers.getInventory(testInventoryId);
          if (!inventory) throw new HttpError(404, "inventaire de test inconnu");
          return json(inventory);
        }

        const testScopeRunId = routeId(pathname, /^\/api\/test-scopes\/([^/]+)\/run$/);
        if (request.method === "POST" && testScopeRunId !== null) {
          const scope = deps.testers.getScope(testScopeRunId);
          if (!scope) throw new HttpError(404, "scope de test inconnu");
          const inventory = deps.testers.getInventory(scope.inventory_id)!;
          if (deps.runner.activity.isBusy(inventory.conversation_id)) {
            throw new HttpError(409, "une opération est déjà en cours sur cette conversation");
          }
          try {
            return json(deps.testers.startScope(testScopeRunId), 202);
          } catch (error) {
            if (error instanceof TestScopeAlreadyRunningError || error instanceof TesterBusyError) {
              throw new HttpError(409, error.message);
            }
            if (error instanceof SubtaskLimitError) throw new HttpError(429, error.message);
            throw error;
          }
        }

        const conversationDebriefsId = routeId(
          pathname,
          /^\/api\/conversations\/([^/]+)\/debriefs$/,
        );
        const conversationBriefId = routeId(
          pathname,
          /^\/api\/conversations\/([^/]+)\/brief$/,
        );
        if (request.method === "GET" && conversationBriefId !== null) {
          const conversation = deps.conversations.get(conversationBriefId);
          if (!conversation) throw new HttpError(404, "conversation inconnue");
          const sourceId = url.searchParams.get("source");
          if (sourceId !== null) {
            const source = deps.conversations.get(sourceId);
            if (!source) throw new HttpError(404, "conversation source inconnue");
            if (
              source.id === conversation.id
              || source.project_id !== conversation.project_id
              || source.ticket_id === null
              || source.ticket_id !== conversation.ticket_id
            ) {
              throw new HttpError(403, "conversation sœur inaccessible");
            }
          }
          const exchanges = deps.conversations.listEvents(conversation.id)
            .flatMap((event) => {
              if (event.type === "user-message") {
                return [{ role: "user" as const, text: event.text.slice(0, 2_000) }];
              }
              if (event.type === "text-final") {
                return [{ role: "assistant" as const, text: event.text.slice(0, 2_000) }];
              }
              return [];
            })
            .slice(-12);
          return json({
            id: conversation.id,
            title: conversation.title,
            summary: conversation.summary,
            provider: conversation.provider,
            updated_at: conversation.updated_at,
            debrief: deps.debriefs.latest(conversation.id)?.content_md ?? null,
            exchanges,
          });
        }
        if (request.method === "GET" && conversationDebriefsId !== null) {
          if (!deps.conversations.get(conversationDebriefsId)) {
            throw new HttpError(404, "conversation inconnue");
          }
          return json(deps.debriefs.listByConversation(conversationDebriefsId));
        }

        const debriefId = routeId(pathname, /^\/api\/debriefs\/([^/]+)$/);
        if (request.method === "GET" && debriefId !== null) {
          const debrief = deps.debriefs.get(debriefId);
          if (!debrief) throw new HttpError(404, "débrief inconnu");
          return json(debrief);
        }

        const conversationHandoffDocumentId = routeId(
          pathname,
          /^\/api\/conversations\/([^/]+)\/handoff-document$/,
        );
        if (request.method === "POST" && conversationHandoffDocumentId !== null) {
          const source = deps.conversations.get(conversationHandoffDocumentId);
          if (!source) throw new HttpError(404, "conversation inconnue");
          if (deps.runner.activity.isBusy(source.id)) {
            throw new HttpError(409, "un tour est déjà en cours");
          }
          try {
            return await deps.debriefs.withHandoff(source.id, async (artifact) => {
              const stamp = new Date().toISOString().replace(/[:.]/g, "-");
              return json({
                debriefId: artifact.latest.id,
                filename: `handoff-${safeFilename(source.title)}-${stamp}.md`,
                contentMd: handoffDocument(source.title, artifact.contentMd),
                createdAt: new Date().toISOString(),
              }, 201);
            });
          } catch (error) {
            if (error instanceof DebriefAlreadyRunningError) {
              throw new HttpError(409, error.message);
            }
            throw new HttpError(
              502,
              error instanceof Error ? error.message : "échec du document de handoff",
            );
          }
        }

        const conversationHandoffId = routeId(
          pathname,
          /^\/api\/conversations\/([^/]+)\/handoff$/,
        );
        if (request.method === "POST" && conversationHandoffId !== null) {
          const source = deps.conversations.get(conversationHandoffId);
          if (!source) throw new HttpError(404, "conversation inconnue");
          if (deps.runner.activity.isBusy(source.id)) {
            throw new HttpError(409, "un tour est déjà en cours");
          }
          const body = await readObject(request);
          const provider = requiredString(body, "provider");
          if (provider !== "claude" && provider !== "codex") {
            throw new HttpError(400, "provider invalide");
          }
          if (provider === source.provider) {
            throw new HttpError(409, "la passation exige un autre provider");
          }
          const model = requiredString(body, "model");
          const effort = optionalEffort(body, provider);
          const speed = optionalSpeed(body, provider);
          const orchestrator = optionalBoolean(body, "orchestrator", true);
          try {
            return await deps.debriefs.withHandoff(source.id, async (artifact) => {
              return json(await createContinuationFromHandoff(
                deps,
                source,
                { provider, model, effort, speed, orchestrator },
                artifact,
              ), 201);
            });
          } catch (error) {
            if (error instanceof DebriefAlreadyRunningError) {
              throw new HttpError(409, error.message);
            }
            throw new HttpError(
              502,
              error instanceof Error ? error.message : "échec du débrief de passation",
            );
          }
        }

        const conversationHandoffConversationId = routeId(
          pathname,
          /^\/api\/conversations\/([^/]+)\/handoff-conversation$/,
        );
        if (request.method === "POST" && conversationHandoffConversationId !== null) {
          const source = deps.conversations.get(conversationHandoffConversationId);
          if (!source) throw new HttpError(404, "conversation inconnue");
          if (deps.runner.activity.isBusy(source.id)) {
            throw new HttpError(409, "un tour est déjà en cours");
          }
          const body = await readObject(request);
          const provider = requiredString(body, "provider");
          if (provider !== "claude" && provider !== "codex") {
            throw new HttpError(400, "provider invalide");
          }
          const model = requiredString(body, "model");
          const effort = optionalEffort(body, provider);
          const speed = optionalSpeed(body, provider);
          const orchestrator = optionalBoolean(body, "orchestrator", true);
          try {
            return await deps.debriefs.withHandoff(source.id, async (artifact) => json(
              await createContinuationFromHandoff(
                deps,
                source,
                { provider, model, effort, speed, orchestrator },
                artifact,
              ),
              201,
            ));
          } catch (error) {
            if (error instanceof DebriefAlreadyRunningError) {
              throw new HttpError(409, error.message);
            }
            throw new HttpError(
              502,
              error instanceof Error ? error.message : "échec de la nouvelle conversation",
            );
          }
        }

        const messageConversationId = routeId(
          pathname,
          /^\/api\/conversations\/([^/]+)\/messages$/,
        );
        if (request.method === "POST" && messageConversationId !== null) {
          const target = deps.conversations.get(messageConversationId);
          if (!target) {
            throw new HttpError(404, "conversation inconnue");
          }
          // Une continuation dont la passation n'est pas finalisée peut encore
          // être supprimée par le nettoyage : y écrire perdrait le tour.
          if (target.handoff_pending) {
            throw new HttpError(409, "passation en cours sur cette conversation");
          }
          const body = await readObject(request);
          const { message, images, attachments } = messageWithAttachments(body, deps.media);
          if (deps.runner.isRunning(messageConversationId)) {
            let steered: boolean;
            try {
              steered = await deps.runner.steerTurn(
                messageConversationId,
                message,
                images,
                attachments,
              );
            } catch (error) {
              throw new HttpError(
                409,
                error instanceof Error ? error.message : "orientation du tour impossible",
              );
            }
            if (steered) return json({ delivery: "steered" }, 202);
          }
          if (deps.runner.activity.isBusy(messageConversationId)) {
            throw new HttpError(409, "un tour est déjà en cours");
          }
          void deps.runner.runTurn(messageConversationId, message, images, attachments)
            .catch((error) => console.error("Échec du tour", error));
          return json({ delivery: "started" }, 202);
        }

        const cancelConversationId = routeId(
          pathname,
          /^\/api\/conversations\/([^/]+)\/cancel$/,
        );
        if (request.method === "POST" && cancelConversationId !== null) {
          if (!deps.conversations.get(cancelConversationId)) {
            throw new HttpError(404, "conversation inconnue");
          }
          // Annulation en cascade : le tour parent ET ses sous-tâches en vol.
          // Les sub-agents tournent en parallèle du parent (ils ne prennent pas
          // son verrou) ; ne tuer que le parent les laisserait continuer sans
          // personne pour lire leur résultat.
          const [cancelledTurn, cancelledSubtasks] = await Promise.all([
            deps.runner.cancelTurn(cancelConversationId),
            deps.subtasks.cancelByConversation(cancelConversationId),
          ]);
          if (!cancelledTurn && cancelledSubtasks === 0) {
            throw new HttpError(409, "aucun tour en cours");
          }
          return empty(202);
        }

        const conversationPinId = routeId(
          pathname,
          /^\/api\/conversations\/([^/]+)\/pin$/,
        );
        if (request.method === "POST" && conversationPinId !== null) {
          if (!deps.conversations.get(conversationPinId)) {
            throw new HttpError(404, "conversation inconnue");
          }
          const body = await readObject(request);
          deps.conversations.setPinned(conversationPinId, requiredPinned(body));
          return empty(204);
        }

        const conversationRenameId = routeId(
          pathname,
          /^\/api\/conversations\/([^/]+)\/rename$/,
        );
        if (request.method === "POST" && conversationRenameId !== null) {
          if (!deps.conversations.get(conversationRenameId)) {
            throw new HttpError(404, "conversation inconnue");
          }
          const body = await readObject(request);
          const title = requiredString(body, "title");
          return json(deps.conversations.rename(conversationRenameId, title));
        }

        const conversationArchiveId = routeId(
          pathname,
          /^\/api\/conversations\/([^/]+)\/archive$/,
        );
        if (request.method === "POST" && conversationArchiveId !== null) {
          if (!deps.conversations.get(conversationArchiveId)) {
            throw new HttpError(404, "conversation inconnue");
          }
          const body = await readObject(request);
          if (typeof body.archived !== "boolean") {
            throw new HttpError(400, "champ archived invalide");
          }
          return json(deps.conversations.setArchived(conversationArchiveId, body.archived));
        }

        // Vider la corbeille : suppression définitive, donc sur sa propre route
        // plutôt qu'en effet de bord d'une autre.
        if (request.method === "POST" && pathname === "/api/conversations/trash/purge") {
          return json({ purged: deps.conversations.purgeTrashed() });
        }

        const conversationTrashId = routeId(
          pathname,
          /^\/api\/conversations\/([^/]+)\/trash$/,
        );
        if (request.method === "POST" && conversationTrashId !== null) {
          if (!deps.conversations.get(conversationTrashId)) {
            throw new HttpError(404, "conversation inconnue");
          }
          const body = await readObject(request);
          if (typeof body.deleted !== "boolean") {
            throw new HttpError(400, "champ deleted invalide");
          }
          const updated = deps.conversations.setDeleted(conversationTrashId, body.deleted);
          return json(updated);
        }

        const conversationEventsId = routeId(
          pathname,
          /^\/api\/conversations\/([^/]+)\/events$/,
        );
        if (request.method === "GET" && conversationEventsId !== null) {
          if (!deps.conversations.get(conversationEventsId)) {
            throw new HttpError(404, "conversation inconnue");
          }
          return json(deps.conversations.listEvents(conversationEventsId));
        }

        const conversationDiffId = routeId(
          pathname,
          /^\/api\/conversations\/([^/]+)\/diff$/,
        );
        if (request.method === "GET" && conversationDiffId !== null) {
          if (!deps.conversations.get(conversationDiffId)) {
            throw new HttpError(404, "conversation inconnue");
          }
          try {
            return json(await deps.reviews.conversationDiff(conversationDiffId));
          } catch (error) {
            if (
              error instanceof Error
              && (error.message.includes("trop volumineux") || error.message.includes("HEAD a changé"))
            ) {
              throw new HttpError(400, error.message);
            }
            throw error;
          }
        }

        const conversationHtmlDocumentsId = routeId(
          pathname,
          /^\/api\/conversations\/([^/]+)\/(?:html-documents|documents)$/,
        );
        if (request.method === "POST" && conversationHtmlDocumentsId !== null) {
          if (!deps.htmlDocuments) throw new HttpError(501, "documents non câblés");
          const body = await readObject(request);
          if (typeof body.deleteSource !== "undefined" && typeof body.deleteSource !== "boolean") {
            throw new HttpError(400, "champ deleteSource invalide");
          }
          if (body.summary !== undefined && body.summary !== null && typeof body.summary !== "string") {
            throw new HttpError(400, "champ summary invalide");
          }
          try {
            return json(await deps.htmlDocuments.publish(conversationHtmlDocumentsId, {
              path: requiredString(body, "path"),
              title: requiredString(body, "title"),
              summary: typeof body.summary === "string" ? body.summary : null,
              deleteSource: body.deleteSource === true,
            }), 201);
          } catch (error) {
            htmlDocumentHttpError(error);
          }
        }

        if (request.method === "GET" && pathname === "/api/documents") {
          if (!deps.htmlDocuments) throw new HttpError(501, "documents non câblés");
          const kind = url.searchParams.get("kind");
          const state = url.searchParams.get("state");
          if (kind !== null && kind !== "html" && kind !== "pdf") throw new HttpError(400, "kind invalide");
          if (state !== null && !["active", "retained", "available"].includes(state)) throw new HttpError(400, "state invalide");
          return json(await deps.htmlDocuments.list({
            projectId: url.searchParams.get("projectId") ?? undefined,
            query: url.searchParams.get("q") ?? undefined,
            kind: (kind ?? undefined) as "html" | "pdf" | undefined,
            state: (state ?? undefined) as "active" | "retained" | "available" | undefined,
          }));
        }

        const htmlDocumentViewTokenId = routeId(
          pathname,
          /^\/api\/(?:html-documents|documents)\/([^/]+)\/view-token$/,
        );
        if (request.method === "POST" && htmlDocumentViewTokenId !== null) {
          if (!deps.htmlDocuments) throw new HttpError(501, "documents HTML non câblés");
          try {
            return json(deps.htmlDocuments.issueViewToken(htmlDocumentViewTokenId), 201);
          } catch (error) {
            htmlDocumentHttpError(error);
          }
        }

        const htmlDocumentRetainId = routeId(
          pathname,
          /^\/api\/(?:html-documents|documents)\/([^/]+)\/retain$/,
        );
        if (request.method === "POST" && htmlDocumentRetainId !== null) {
          if (!deps.htmlDocuments) throw new HttpError(501, "documents HTML non câblés");
          try {
            return json(deps.htmlDocuments.retain(htmlDocumentRetainId));
          } catch (error) {
            htmlDocumentHttpError(error);
          }
        }

        const documentThumbnailId = routeId(
          pathname,
          /^\/api\/documents\/([^/]+)\/thumbnail$/,
        );
        if (request.method === "GET" && documentThumbnailId !== null) {
          if (!deps.htmlDocuments) throw new HttpError(501, "documents non câblés");
          try {
            const thumbnail = deps.htmlDocuments.thumbnail(documentThumbnailId);
            const file = Bun.file(thumbnail.path);
            if (!(await file.exists())) throw new HttpError(410, "miniature indisponible");
            return new Response(file, {
              headers: {
                ...TAURI_CORS_HEADERS,
                "content-type": thumbnail.mimeType,
                "cache-control": "private, max-age=86400",
                "x-content-type-options": "nosniff",
              },
            });
          } catch (error) {
            if (error instanceof HttpError) throw error;
            htmlDocumentHttpError(error);
          }
        }

        const documentExportId = routeId(
          pathname,
          /^\/api\/documents\/([^/]+)\/export$/,
        );
        if (request.method === "POST" && documentExportId !== null) {
          if (!deps.htmlDocuments) throw new HttpError(501, "documents non câblés");
          const body = await readObject(request);
          try {
            return json(deps.htmlDocuments.exportTo(
              documentExportId,
              requiredString(body, "path"),
            ));
          } catch (error) {
            htmlDocumentHttpError(error);
          }
        }

        const htmlDocumentContentId = routeId(
          pathname,
          /^\/api\/(?:html-documents|documents)\/([^/]+)\/content$/,
        );
        if (request.method === "GET" && htmlDocumentContentId !== null) {
          if (!deps.htmlDocuments) throw new HttpError(501, "documents HTML non câblés");
          try {
            const content = deps.htmlDocuments.content(
              htmlDocumentContentId,
              url.searchParams.get("token") ?? "",
            );
            const file = Bun.file(content.path);
            if (!(await file.exists())) throw new HttpError(410, "contenu indisponible");
            return new Response(file, {
              headers: {
                ...TAURI_CORS_HEADERS,
                "content-type": content.kind === "html" ? "text/html; charset=utf-8" : content.mimeType,
                "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(content.originalName)}`,
                "cache-control": "no-store",
                ...(content.kind === "html" ? { "content-security-policy": [
                  "default-src 'none'",
                  "style-src 'unsafe-inline'",
                  "script-src 'unsafe-inline'",
                  "img-src data: blob:",
                  "font-src data:",
                  "media-src data: blob:",
                  "connect-src 'none'",
                  "form-action 'none'",
                  "base-uri 'none'",
                  "object-src 'none'",
                  "sandbox allow-scripts allow-modals",
                ].join("; ") } : {}),
                "referrer-policy": "no-referrer",
                "x-content-type-options": "nosniff",
              },
            });
          } catch (error) {
            if (error instanceof HttpError) throw error;
            htmlDocumentHttpError(error);
          }
        }

        const htmlDocumentId = routeId(pathname, /^\/api\/(?:html-documents|documents)\/([^/]+)$/);
        if (request.method === "GET" && htmlDocumentId !== null) {
          if (!deps.htmlDocuments) throw new HttpError(501, "documents non câblés");
          const document = deps.htmlDocuments.get(htmlDocumentId);
          if (!document) throw new HttpError(404, "document inconnu");
          return json(document);
        }
        if (request.method === "DELETE" && htmlDocumentId !== null) {
          if (!deps.htmlDocuments) throw new HttpError(501, "documents HTML non câblés");
          try {
            return json(deps.htmlDocuments.delete(htmlDocumentId));
          } catch (error) {
            htmlDocumentHttpError(error);
          }
        }

        if (request.method === "POST" && pathname === "/api/reviews") {
          const body = await readObject(request);
          const conversationId = requiredString(body, "conversationId");
          const conversation = deps.conversations.get(conversationId);
          if (!conversation) throw new HttpError(404, "conversation inconnue");
          const project = deps.projects.get(conversation.project_id);
          if (!project) throw new HttpError(404, "projet inconnu");
          const cooldown = reviewCooldownSeconds(deps.reviews.listByProject(project.id), conversationId);
          if (cooldown > 0) {
            throw new HttpError(429, `Patientez ${cooldown} s avant une nouvelle review.`);
          }
          for (const field of ["reviewProvider", "reviewModel", "reviewEffort", "reviewSpeed", "presetId", "codeProvider"]) {
            if (body[field] !== undefined) {
              throw new HttpError(400, "configuration de review portée par le projet");
            }
          }
          const scope = body.scope === undefined ? "worktree" : requiredString(body, "scope");
          const gitRefBase = body.gitRefBase === undefined
            ? "CONVERSATION"
            : requiredString(body, "gitRefBase");
          const gitRefHead = body.gitRefHead === undefined
            ? "WORKTREE"
            : requiredString(body, "gitRefHead");
          if (body.incremental !== undefined && typeof body.incremental !== "boolean") {
            throw new HttpError(400, "incremental invalide");
          }
          const incremental = body.incremental === undefined
            ? scope === "worktree"
            : body.incremental;
          const config = resolveReviewConfig(project, conversation, deps.presets);
          try {
            return json(deps.reviews.start({
              projectId: project.id,
              conversationId,
              gitRefBase,
              gitRefHead,
              provider: config.provider,
              model: config.model,
              effort: config.effort,
              speed: config.speed,
              codeProvider: conversation.provider,
              scope,
              incremental,
            }), 201);
          } catch (error) {
            if (error instanceof Error && error.message.includes("inconnu")) {
              throw new HttpError(404, error.message);
            }
            throw error;
          }
        }

        const projectReviewsId = routeId(
          pathname,
          /^\/api\/projects\/([^/]+)\/reviews$/,
        );
        if (request.method === "GET" && projectReviewsId !== null) {
          if (!deps.projects.get(projectReviewsId)) {
            throw new HttpError(404, "projet inconnu");
          }
          return json(deps.reviews.listByProject(projectReviewsId));
        }

        const projectReviewStatusId = routeId(
          pathname,
          /^\/api\/projects\/([^/]+)\/review-status$/,
        );
        if (request.method === "GET" && projectReviewStatusId !== null) {
          const status = deps.reviews.reviewStatus(projectReviewStatusId);
          if (!status) throw new HttpError(404, "projet inconnu");
          return json(status);
        }

        const reviewId = routeId(pathname, /^\/api\/reviews\/([^/]+)$/);
        if (request.method === "GET" && reviewId !== null) {
          const review = deps.reviews.get(reviewId);
          if (!review) throw new HttpError(404, "review inconnue");
          return json(review);
        }

        const reviewFlagId = routeId(pathname, /^\/api\/review-flags\/([^/]+)$/);
        if (request.method === "PATCH" && reviewFlagId !== null) {
          const body = await readObject(request);
          if (body.status !== undefined) {
            if (body.status !== "open" && body.status !== "agent_running" && body.status !== "treated"
              && body.status !== "ignored" && body.status !== "resolved") {
              throw new HttpError(400, "statut de flag invalide");
            }
          }
          if (body.status === undefined) {
            throw new HttpError(400, "aucune modification de flag demandée");
          }
          const flag = deps.reviews.updateFlag(reviewFlagId, { status: body.status });
          if (!flag) throw new HttpError(404, "flag inconnu");
          return json(flag);
        }

        const reviewFlagDispatchId = routeId(
          pathname,
          /^\/api\/review-flags\/([^/]+)\/dispatch$/,
        );
        if (request.method === "POST" && reviewFlagDispatchId !== null) {
          const body = await readObject(request);
          if (body.message !== undefined && typeof body.message !== "string") {
            throw new HttpError(400, "message invalide");
          }
          const flag = deps.reviews.getFlag(reviewFlagDispatchId);
          if (!flag) throw new HttpError(404, "flag inconnu");
          const review = deps.reviews.get(flag.review_id);
          if (!review) throw new HttpError(404, "review inconnue");
          const conversation = deps.conversations.get(review.conversation_id);
          if (!conversation) throw new HttpError(404, "conversation inconnue");
          const project = deps.projects.get(conversation.project_id);
          if (!project) throw new HttpError(404, "projet inconnu");
          const agentConfig = resolveCorrectionConfig(project, conversation, flag.code_provider, deps.presets);
          try {
            return json(deps.reviews.dispatchFlag(reviewFlagDispatchId, body.message, agentConfig), 201);
          } catch (error) {
            if (error instanceof DispatchConflictError) throw new HttpError(409, error.message);
            if (error instanceof Error && error.message === "flag inconnu") throw new HttpError(404, error.message);
            throw error;
          }
        }

        const reviewDispatchAllId = routeId(pathname, /^\/api\/reviews\/([^/]+)\/dispatch-all$/);
        if (request.method === "POST" && reviewDispatchAllId !== null) {
          const body = await readObject(request);
          const severities = body.severities === undefined ? ["red", "orange"] : body.severities;
          if (!Array.isArray(severities) || !severities.every((item) => item === "red" || item === "orange" || item === "grey")) {
            throw new HttpError(400, "sévérités invalides");
          }
          const review = deps.reviews.get(reviewDispatchAllId);
          if (!review) throw new HttpError(404, "review inconnu");
          const conversation = deps.conversations.get(review.conversation_id);
          if (!conversation) throw new HttpError(404, "conversation inconnue");
          const project = deps.projects.get(conversation.project_id);
          if (!project) throw new HttpError(404, "projet inconnu");
          const agentConfig = resolveCorrectionConfig(project, conversation, review.code_provider, deps.presets);
          try {
            return json(deps.reviews.dispatchAll(reviewDispatchAllId, severities, agentConfig), 202);
          } catch (error) {
            if (error instanceof Error && error.message === "review inconnu") throw new HttpError(404, error.message);
            throw error;
          }
        }

        const reviewDispatchGroupedId = routeId(pathname, /^\/api\/reviews\/([^/]+)\/dispatch-grouped$/);
        if (request.method === "POST" && reviewDispatchGroupedId !== null) {
          const body = await readObject(request);
          const severities = body.severities === undefined ? ["red", "orange"] : body.severities;
          if (!Array.isArray(severities) || !severities.every((item) => item === "red" || item === "orange" || item === "grey")) {
            throw new HttpError(400, "sévérités invalides");
          }
          const review = deps.reviews.get(reviewDispatchGroupedId);
          if (!review) throw new HttpError(404, "review inconnu");
          const conversation = deps.conversations.get(review.conversation_id);
          if (!conversation) throw new HttpError(404, "conversation inconnue");
          const project = deps.projects.get(conversation.project_id);
          if (!project) throw new HttpError(404, "projet inconnu");
          const agentConfig = resolveCorrectionConfig(project, conversation, review.code_provider, deps.presets);
          try {
            return json(await deps.reviews.dispatchGrouped(reviewDispatchGroupedId, severities, agentConfig), 202);
          } catch (error) {
            if (error instanceof DispatchConflictError) throw new HttpError(409, error.message);
            if (error instanceof Error && error.message === "review inconnu") throw new HttpError(404, error.message);
            throw error;
          }
        }

        if (request.method === "POST" && pathname === "/api/subtasks") {
          const body = await readObject(request);
          const conversationId = requiredString(body, "conversationId");
          const conversation = deps.conversations.get(conversationId);
          if (!conversation) {
            throw new HttpError(404, "conversation inconnue");
          }
          const provider = requiredString(body, "provider");
          if (provider !== "claude" && provider !== "codex") {
            throw new HttpError(400, "provider invalide");
          }
          const model = requiredString(body, "model");
          // Quand la conversation impose déjà un preset ou un effort, les
          // valeurs demandées par l'outil MCP sont volontairement ignorées :
          // cela rend le verrou effectif même si l'orchestrateur demande autre
          // chose dans son appel delegate.
          const parentLocksSubagent = conversation.subagent_preset_id !== null
            || conversation.subagent_effort !== null;
          const effort = parentLocksSubagent
            ? null
            : optionalEffort(body, provider as Provider);
          const speed = parentLocksSubagent
            ? null
            : optionalSpeed(body, provider as Provider);
          const prompt = requiredString(body, "prompt");
          const label = optionalLabel(body);
          const effective = effectiveSubtaskConfig(conversation, {
            provider: provider as Provider,
            model,
            effort,
            speed,
          }, deps.presets);
          try {
            // Lancement asynchrone : on rend l'id tout de suite, le suivi passe
            // par /ws?conversation=<id> ou GET /api/subtasks/:id.
            const subtask = deps.subtasks.start({
              conversationId,
              provider: effective.provider,
              model: effective.model,
              effort: effective.effort,
              speed: effective.speed,
              prompt,
              label,
            });
            return json({ id: subtask.id }, 201);
          } catch (error) {
            if (error instanceof SubtaskLimitError) {
              throw new HttpError(429, error.message);
            }
            throw error;
          }
        }

        const subtaskEventsId = routeId(
          pathname,
          /^\/api\/subtasks\/([^/]+)\/events$/,
        );
        if (request.method === "GET" && subtaskEventsId !== null) {
          if (!deps.subtasks.get(subtaskEventsId)) {
            throw new HttpError(404, "sous-tâche inconnue");
          }
          // Même table, même replay que pour une conversation.
          return json(deps.conversations.listEvents(subtaskEventsId));
        }

        const subtaskCancelId = routeId(
          pathname,
          /^\/api\/subtasks\/([^/]+)\/cancel$/,
        );
        if (request.method === "POST" && subtaskCancelId !== null) {
          if (!deps.subtasks.get(subtaskCancelId)) {
            throw new HttpError(404, "sous-tâche inconnue");
          }
          const cancelled = await deps.subtasks.cancel(subtaskCancelId);
          if (!cancelled) throw new HttpError(409, "sous-tâche déjà terminée");
          return empty(202);
        }

        const subtaskId = routeId(pathname, /^\/api\/subtasks\/([^/]+)$/);
        if (request.method === "GET" && subtaskId !== null) {
          const result = deps.subtasks.result(subtaskId);
          if (!result) throw new HttpError(404, "sous-tâche inconnue");
          return json(result);
        }

        const conversationSubtasksId = routeId(
          pathname,
          /^\/api\/conversations\/([^/]+)\/subtasks$/,
        );
        if (request.method === "GET" && conversationSubtasksId !== null) {
          if (!deps.conversations.get(conversationSubtasksId)) {
            throw new HttpError(404, "conversation inconnue");
          }
          return json(deps.subtasks.listByConversation(conversationSubtasksId));
        }

        if (request.method === "POST" && pathname === "/api/media/import") {
          const body = await readObject(request);
          const sourcePath = droppedFilePath(requiredString(body, "path"));
          const limit = byteLimit("PUPITRE_MEDIA_MAX_BYTES", DEFAULT_MEDIA_MAX_BYTES);
          let stat: ReturnType<typeof statSync>;
          try {
            stat = statSync(sourcePath);
          } catch {
            throw new HttpError(400, "fichier introuvable");
          }
          if (!stat.isFile()) throw new HttpError(400, "le chemin déposé n'est pas un fichier");
          if (stat.size === 0) throw new HttpError(400, "fichier vide");
          if (stat.size > limit) throw new HttpError(413, "fichier trop volumineux");
          const originalName = basename(sourcePath) || "piece-jointe";
          const mimeType = mediaMimeType(null, originalName);
          const name = deps.media.importFile(sourcePath);
          return json({
            name,
            originalName,
            mimeType,
            size: stat.size,
          }, 201);
        }

        if (request.method === "POST" && pathname === "/api/media") {
          const limit = byteLimit("PUPITRE_MEDIA_MAX_BYTES", DEFAULT_MEDIA_MAX_BYTES);
          const declaredLength = Number(request.headers.get("content-length"));
          if (Number.isFinite(declaredLength) && declaredLength > limit) {
            throw new HttpError(413, "fichier trop volumineux");
          }
          const bytes = Buffer.from(await request.arrayBuffer());
          if (bytes.length === 0) throw new HttpError(400, "fichier vide");
          if (bytes.length > limit) throw new HttpError(413, "fichier trop volumineux");
          const originalName = fileNameHeader(request.headers.get("x-file-name"));
          const contentType = mediaMimeType(
            request.headers.get("content-type"),
            originalName,
          );
          const name = deps.media.importBytes(
            bytes,
            mediaExtension(contentType, originalName),
          );
          return json({
            name,
            originalName,
            mimeType: contentType,
            size: bytes.length,
          }, 201);
        }

        const mediaName = routeId(pathname, /^\/media\/([^/]+)$/);
        if (request.method === "GET" && mediaName !== null) {
          let file: ReturnType<typeof Bun.file>;
          try {
            file = Bun.file(deps.media.absolutePath(mediaName));
          } catch {
            throw new HttpError(400, "nom media invalide");
          }
          if (!(await file.exists())) throw new HttpError(404, "media inconnu");
          return new Response(file, { headers: TAURI_CORS_HEADERS });
        }

        if (request.method === "GET" && pathname === "/api/quotas") {
          return json(deps.quotas.snapshot());
        }

        // Relève immédiate des deux providers, sans attendre le tour de poll.
        if (request.method === "POST" && pathname === "/api/quotas/refresh") {
          return json(await deps.quotaRefresher.refresh());
        }

        if (request.method === "GET" && pathname === "/ws") {
          const channel = url.searchParams.get("channel");
          if (channel === "quotas") {
            if (server.upgrade(request, { data: { channel: "quotas" } })) return;
            throw new HttpError(400, "upgrade WebSocket refusé");
          }
          if (channel === "fleet") {
            if (server.upgrade(request, { data: { channel: "fleet" } })) return;
            throw new HttpError(400, "upgrade WebSocket refusé");
          }
          if (channel === "tickets") {
            const projectId = url.searchParams.get("project");
            if (!projectId || !deps.projects.get(projectId)) {
              throw new HttpError(404, "projet inconnu");
            }
            if (server.upgrade(request, { data: { channel: "tickets", projectId } })) return;
            throw new HttpError(400, "upgrade WebSocket refusé");
          }
          if (channel !== null && channel !== "conversation") {
            throw new HttpError(400, "canal inconnu");
          }
          // Le canal accepte un id de conversation OU de subtask : les events
          // d'une subtask sont diffusés sous son propre id (cf. SubtaskRunner).
          const conversationId = url.searchParams.get("conversation");
          if (
            !conversationId
            || (!deps.conversations.get(conversationId) && !deps.subtasks.get(conversationId))
          ) {
            throw new HttpError(404, "conversation inconnue");
          }
          const data = { channel: "conversation", conversationId } as const;
          if (server.upgrade(request, { data })) {
            return;
          }
          throw new HttpError(400, "upgrade WebSocket refusé");
        }

        throw new HttpError(404, "route inconnue");
      } catch (error) {
        if (error instanceof HttpError) {
          return json({ error: error.message }, error.status);
        }
        console.error("Erreur serveur", error);
        return json({ error: "erreur interne" }, 500);
      }
    },
    websocket: {
      open(socket) {
        if (socket.data.channel === "quotas") {
          quotaSockets.add(socket);
          // État courant à la connexion : pas d'attente du prochain event.
          for (const state of Object.values(deps.quotas.snapshot())) {
            if (state) socket.send(JSON.stringify(state));
          }
          return;
        }
        if (socket.data.channel === "fleet") {
          fleetSockets.add(socket);
          socket.send(JSON.stringify(currentFleet()));
          fleetTimer ??= setInterval(broadcastFleet, 1_000);
          return;
        }
        if (socket.data.channel === "tickets") {
          const { projectId } = socket.data;
          let subscribers = ticketSockets.get(projectId);
          if (!subscribers) {
            subscribers = new Set();
            ticketSockets.set(projectId, subscribers);
          }
          subscribers.add(socket);
          socket.send(JSON.stringify(dashboardPayload(projectId, deps.integrations, deps.tickets)));
          return;
        }
        const { conversationId } = socket.data;
        let subscribers = sockets.get(conversationId);
        if (!subscribers) {
          subscribers = new Set();
          sockets.set(conversationId, subscribers);
        }
        subscribers.add(socket);
      },
      close(socket) {
        if (socket.data.channel === "quotas") {
          quotaSockets.delete(socket);
          return;
        }
        if (socket.data.channel === "fleet") {
          fleetSockets.delete(socket);
          if (fleetSockets.size === 0 && fleetTimer) {
            clearInterval(fleetTimer);
            fleetTimer = null;
          }
          return;
        }
        if (socket.data.channel === "tickets") {
          const { projectId } = socket.data;
          const subscribers = ticketSockets.get(projectId);
          subscribers?.delete(socket);
          if (subscribers?.size === 0) ticketSockets.delete(projectId);
          return;
        }
        const { conversationId } = socket.data;
        const subscribers = sockets.get(conversationId);
        subscribers?.delete(socket);
        if (subscribers?.size === 0) sockets.delete(conversationId);
      },
      message() {},
    },
  });
}

/**
 * Démarre le serveur HTTP en réclamant le port au besoin.
 *
 * Scénario visé : un sidecar d'une session précédente (app fermée sans arrêt
 * propre, instance de dev restée ouverte…) tient encore le port. Sans éviction,
 * le nouveau sidecar crashe en boucle pendant que l'UI parle à l'ancien code —
 * les correctifs semblent alors ne jamais s'appliquer. Le nouveau sidecar
 * demande donc à l'ancien de s'arrêter (`POST /api/shutdown`) puis réessaie.
 */
export async function claimServer(
  start: () => ReturnType<typeof createServer>,
  port: number,
): Promise<ReturnType<typeof createServer>> {
  try {
    return start();
  } catch (error) {
    if ((error as { code?: string }).code !== "EADDRINUSE") throw error;
  }
  const evicted = await requestSidecarShutdown(`http://127.0.0.1:${port}`);
  if (!evicted) {
    throw new Error(
      `port ${port} occupé par un process qui n'est pas un sidecar Pupitre : `
      + "libérez-le ou changez PUPITRE_PORT",
    );
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    await Bun.sleep(200);
    try {
      return start();
    } catch (error) {
      if ((error as { code?: string }).code !== "EADDRINUSE") throw error;
    }
  }
  throw new Error(`port ${port} toujours occupé après l'éviction du sidecar précédent`);
}

/** Vrai si un sidecar Pupitre a répondu au health check ET accepté de s'arrêter. */
async function requestSidecarShutdown(baseUrl: string): Promise<boolean> {
  try {
    const health = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1_000) });
    if (!health.ok) return false;
    const body = (await health.json().catch(() => null)) as { ok?: boolean } | null;
    if (body?.ok !== true) return false;
    const shutdown = await fetch(`${baseUrl}/api/shutdown`, {
      method: "POST",
      signal: AbortSignal.timeout(1_000),
    });
    return shutdown.ok;
  } catch {
    return false;
  }
}
