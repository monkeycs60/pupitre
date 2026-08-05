import type { ServerWebSocket } from "bun";
import { existsSync } from "node:fs";
import type { Provider, StoredEvent } from "./events";
import type { MediaStore } from "./media";
import type { ConversationRunner } from "./runner";
import type { ConversationStore } from "./stores/conversations";
import type { ProjectStore } from "./stores/projects";
import type { PresetInput, PresetStore } from "./stores/presets";
import { defaultReviewConfig } from "./stores/presets";
import type { SettingsStore } from "./stores/settings";
import type { QuotaTracker } from "./quotas";
import { SubtaskLimitError, type SubtaskRunner } from "./subtasks";
import type { ReviewRunner } from "./reviews";
import { CounterAlreadyRunningError } from "./stores/reviews";
import {
  DebriefAlreadyRunningError,
  NoNewDebriefEventsError,
  type DebriefRunner,
} from "./debriefs";
import { GitProjectError, type GitProjectService } from "./git";
import {
  TesterBusyError,
  TestScopeAlreadyRunningError,
  type TesterRunner,
} from "./testing";

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
  subtasks: SubtaskRunner;
  presets: PresetStore;
  settings: SettingsStore;
  reviews: ReviewRunner;
  debriefs: DebriefRunner;
  git: GitProjectService;
  testers: TesterRunner;
}

// Deux canaux WS sur la même route : par conversation (défaut historique) et le
// canal global `quotas`.
type WebSocketData =
  | { channel: "conversation"; conversationId: string }
  | { channel: "quotas" };

const EFFORTS_BY_PROVIDER = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["low", "medium", "high", "xhigh"],
} as const satisfies Record<Provider, readonly string[]>;
const SPEEDS = ["standard", "fast"] as const;
const DEFAULT_MEDIA_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MESSAGE_MEDIA_MAX_BYTES = 25 * 1024 * 1024;

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
  "access-control-allow-headers": "content-type",
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

function strongReviewModel(model: string, field: string): string {
  const value = model.trim();
  if (/haiku|luna/i.test(value)) {
    throw new HttpError(400, `${field} doit être un modèle fort`);
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
  const imageLimit = byteLimit("PUPITRE_MEDIA_MAX_BYTES", DEFAULT_MEDIA_MAX_BYTES);
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
    if (size > imageLimit) {
      throw new HttpError(413, `image trop volumineuse : ${name}`);
    }
    total += size;
    if (total > totalLimit) {
      throw new HttpError(413, "taille totale des images dépassée");
    }
  }
  return images;
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
    strongReviewModel(reviewModelValue, "review_model");
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
  return {
    name,
    provider,
    model: requiredString(body, "model"),
    effort: optionalEffort(body, provider),
    speed: optionalSpeed(body, provider),
    orchestrator: optionalBoolean(body, "orchestrator", true),
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

function reviewModelConfig(
  body: Record<string, unknown>,
  fallback: { provider: Provider; model: string; effort: string },
): { provider: Provider; model: string; effort: string } {
  const rawProvider = body.reviewProvider;
  if (rawProvider !== undefined && rawProvider !== "claude" && rawProvider !== "codex") {
    throw new HttpError(400, "reviewProvider invalide");
  }
  const provider = (rawProvider as Provider | undefined) ?? fallback.provider;
  const providerFallback = provider === fallback.provider
    ? fallback
    : defaultReviewConfig(provider);
  const rawModel = body.reviewModel;
  if (rawModel !== undefined && (typeof rawModel !== "string" || rawModel.trim() === "")) {
    throw new HttpError(400, "reviewModel invalide");
  }
  const rawEffort = body.reviewEffort;
  if (
    rawEffort !== undefined
    && (typeof rawEffort !== "string"
      || !(EFFORTS_BY_PROVIDER[provider] as readonly string[]).includes(rawEffort))
  ) {
    throw new HttpError(400, `reviewEffort invalide pour ${provider}`);
  }
  const model = typeof rawModel === "string" ? rawModel.trim() : providerFallback.model;
  return {
    provider,
    model: strongReviewModel(model, "reviewModel"),
    effort: typeof rawEffort === "string" ? rawEffort : providerFallback.effort,
  };
}

function mediaExtension(contentType: string | null): string {
  const mime = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  switch (mime) {
    case "image/jpeg": return "jpg";
    case "image/gif": return "gif";
    case "image/webp": return "webp";
    case "image/svg+xml": return "svg";
    case "image/png":
    default:
      return "png";
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

export function createServer(deps: ServerDeps) {
  const sockets = new Map<string, Set<ServerWebSocket<WebSocketData>>>();
  const quotaSockets = new Set<ServerWebSocket<WebSocketData>>();
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

        if (request.method === "GET" && pathname === "/api/projects") {
          return json(deps.projects.list());
        }

        if (request.method === "POST" && pathname === "/api/projects") {
          const body = await readObject(request);
          const name = requiredString(body, "name");
          const path = requiredString(body, "path");
          if (!existsSync(path)) throw new HttpError(400, "path inexistant");
          try {
            return json(deps.projects.create({ name, path }), 201);
          } catch {
            throw new HttpError(409, "projet déjà existant");
          }
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
          if (!base || !head) throw new HttpError(400, "références Git manquantes");
          try {
            return json(await deps.git.diff(projectGitDiffId, base, head));
          } catch (error) {
            if (error instanceof GitProjectError) throw new HttpError(400, error.message);
            throw error;
          }
        }

        const projectGitId = routeId(pathname, /^\/api\/projects\/([^/]+)\/git$/);
        if (request.method === "GET" && projectGitId !== null) {
          if (!deps.projects.get(projectGitId)) throw new HttpError(404, "projet inconnu");
          try {
            return json(deps.git.snapshot(projectGitId));
          } catch (error) {
            if (error instanceof GitProjectError) throw new HttpError(400, error.message);
            throw error;
          }
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
          return json(deps.projects.get(projectDefaultPresetId));
        }

        const projectGardienModeId = routeId(
          pathname,
          /^\/api\/projects\/([^/]+)\/gardien-mode$/,
        );
        if (request.method === "PUT" && projectGardienModeId !== null) {
          if (!deps.projects.get(projectGardienModeId)) {
            throw new HttpError(404, "projet inconnu");
          }
          const body = await readObject(request);
          if (body.mode !== "informatif" && body.mode !== "bloquant") {
            throw new HttpError(400, "mode Gardien invalide");
          }
          deps.projects.setGardienMode(projectGardienModeId, body.mode);
          return json(deps.projects.get(projectGardienModeId));
        }

        const projectAutoCounterId = routeId(
          pathname,
          /^\/api\/projects\/([^/]+)\/auto-counter-red$/,
        );
        if (request.method === "PUT" && projectAutoCounterId !== null) {
          if (!deps.projects.get(projectAutoCounterId)) {
            throw new HttpError(404, "projet inconnu");
          }
          const body = await readObject(request);
          if (typeof body.enabled !== "boolean") {
            throw new HttpError(400, "option de contre-avis automatique invalide");
          }
          deps.projects.setAutoCounterRed(projectAutoCounterId, body.enabled);
          return json(deps.projects.get(projectAutoCounterId));
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
          return json(deps.conversations.listByProject(projectConversationsId));
        }

        if (request.method === "GET" && pathname === "/api/presets") {
          return json(deps.presets.list());
        }

        if (request.method === "POST" && pathname === "/api/presets") {
          const body = await readObject(request);
          const input = presetInput(body);
          try {
            return json(deps.presets.create(input), 201);
          } catch {
            throw new HttpError(409, "nom de preset déjà utilisé");
          }
        }

        const presetId = routeId(pathname, /^\/api\/presets\/([^/]+)$/);
        if (request.method === "PUT" && presetId !== null) {
          const body = await readObject(request);
          try {
            const preset = deps.presets.update(presetId, presetInput(body));
            if (!preset) throw new HttpError(404, "preset inconnu");
            return json(preset);
          } catch (error) {
            if (error instanceof HttpError) throw error;
            if (error instanceof Error && error.message === "preset intégré immuable") {
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
            throw new HttpError(409, "preset intégré immuable");
          }
        }

        if (request.method === "GET" && pathname === "/api/settings") {
          return json(deps.settings.all());
        }

        if (request.method === "PUT" && pathname === "/api/settings") {
          const body = await readObject(request);
          deps.settings.set("quotaThresholds", quotaThresholds(body));
          return json(deps.settings.all());
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
          const message = requiredString(body, "message");
          const images = validatedImages(body, deps.media);
          // Défaut ON : une conversation peut déléguer sauf mention contraire.
          const orchestrator = optionalBoolean(body, "orchestrator", true);
          const conversation = deps.conversations.create({
            projectId,
            provider: provider as Provider,
            model,
            effort,
            speed,
            orchestrator,
            firstMessage: message,
          });
          void deps.runner.runTurn(conversation.id, message, images)
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
              const continuation = deps.conversations.create({
                projectId: source.project_id,
                provider,
                model,
                effort,
                speed,
                orchestrator,
                continuedFrom: source.id,
                handoffPending: true,
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
                return json(deps.conversations.get(continuation.id), 201);
              } catch (error) {
                // Le provider cible peut avoir délégué avant d'échouer. Attendre
                // l'arrêt de ses sous-tâches empêche qu'elles réécrivent des
                // events sous leurs ids après la transaction de nettoyage.
                await deps.subtasks.cancelByConversation(continuation.id);
                deps.conversations.deleteFailedContinuation(continuation.id);
                throw error;
              }
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
          const message = requiredString(body, "message");
          const images = validatedImages(body, deps.media);
          if (deps.runner.activity.isBusy(messageConversationId)) {
            throw new HttpError(409, "un tour est déjà en cours");
          }
          void deps.runner.runTurn(messageConversationId, message, images)
            .catch((error) => console.error("Échec du tour", error));
          return empty(202);
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

        if (request.method === "POST" && pathname === "/api/reviews") {
          const body = await readObject(request);
          const conversationId = requiredString(body, "conversationId");
          const conversation = deps.conversations.get(conversationId);
          if (!conversation) throw new HttpError(404, "conversation inconnue");
          const project = deps.projects.get(conversation.project_id);
          if (!project) throw new HttpError(404, "projet inconnu");

          const requestedPresetId = body.presetId;
          if (
            requestedPresetId !== undefined
            && requestedPresetId !== null
            && typeof requestedPresetId !== "string"
          ) {
            throw new HttpError(400, "presetId invalide");
          }
          const presetId = typeof requestedPresetId === "string"
            ? requestedPresetId
            : project.default_preset_id;
          const preset = presetId ? deps.presets.get(presetId) : null;
          if (presetId && !preset) throw new HttpError(404, "preset inconnu");
          const fallback = preset
            ? {
                provider: preset.review_provider,
                model: preset.review_model,
                effort: preset.review_effort,
              }
            : defaultReviewConfig(conversation.provider);
          const reviewModel = reviewModelConfig(body, fallback);
          const rawCodeProvider = body.codeProvider;
          if (
            rawCodeProvider !== undefined
            && rawCodeProvider !== "claude"
            && rawCodeProvider !== "codex"
          ) {
            throw new HttpError(400, "codeProvider invalide");
          }
          const gitRefBase = body.gitRefBase === undefined
            ? "CONVERSATION"
            : requiredString(body, "gitRefBase");
          const gitRefHead = body.gitRefHead === undefined
            ? "WORKTREE"
            : requiredString(body, "gitRefHead");
          try {
            return json(deps.reviews.start({
              projectId: project.id,
              conversationId,
              gitRefBase,
              gitRefHead,
              provider: reviewModel.provider,
              model: reviewModel.model,
              effort: reviewModel.effort,
              codeProvider: (rawCodeProvider as Provider | undefined) ?? conversation.provider,
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

        const projectGardienStatusId = routeId(
          pathname,
          /^\/api\/projects\/([^/]+)\/gardien-status$/,
        );
        if (request.method === "GET" && projectGardienStatusId !== null) {
          const status = deps.reviews.gardienStatus(projectGardienStatusId);
          if (!status) throw new HttpError(404, "projet inconnu");
          return json(status);
        }

        const reviewId = routeId(pathname, /^\/api\/reviews\/([^/]+)$/);
        if (request.method === "GET" && reviewId !== null) {
          const review = deps.reviews.get(reviewId);
          if (!review) throw new HttpError(404, "review inconnue");
          return json(review);
        }

        const reviewCountersId = routeId(
          pathname,
          /^\/api\/reviews\/([^/]+)\/counter-opinions$/,
        );
        if (request.method === "POST" && reviewCountersId !== null) {
          const review = deps.reviews.get(reviewCountersId);
          if (!review) throw new HttpError(404, "review inconnue");
          if (review.flags.length === 0) throw new HttpError(400, "aucun flag à contre-expertiser");
          const body = await readObject(request);
          const isMixedProvider = new Set(
            review.flags.map((flag) => flag.code_provider),
          ).size > 1;
          if (isMixedProvider && (body.model !== undefined || body.effort !== undefined)) {
            throw new HttpError(
              400,
              "une review multi-provider utilise le modèle fort de chaque provider opposé",
            );
          }
          const defaults = deps.reviews.counterDefaults(review.flags[0]!.id)!;
          const model = strongReviewModel(
            body.model === undefined ? defaults.model : requiredString(body, "model"),
            "model de contre-avis",
          );
          const effort = body.effort === undefined
            ? defaults.effort
            : optionalEffort(body, defaults.provider);
          try {
            return json(deps.reviews.startCounterOpinions(
              review.flags.map((flag) => flag.id),
              isMixedProvider ? {} : { model, effort: effort ?? defaults.effort },
            ), 202);
          } catch (error) {
            if (error instanceof CounterAlreadyRunningError) {
              throw new HttpError(409, error.message);
            }
            throw error;
          }
        }

        const reviewFlagId = routeId(pathname, /^\/api\/review-flags\/([^/]+)$/);
        if (request.method === "PATCH" && reviewFlagId !== null) {
          const body = await readObject(request);
          if (body.status !== undefined) {
            if (body.status !== "open" && body.status !== "acked" && body.status !== "dismissed") {
              throw new HttpError(400, "statut de flag invalide");
            }
          }
          if (body.codeProvider !== undefined) {
            if (body.codeProvider !== "claude" && body.codeProvider !== "codex") {
              throw new HttpError(400, "codeProvider invalide");
            }
          }
          if (body.status === undefined && body.codeProvider === undefined) {
            throw new HttpError(400, "aucune modification de flag demandée");
          }
          try {
            const flag = deps.reviews.updateFlag(reviewFlagId, {
              status: body.status,
              codeProvider: body.codeProvider,
            });
            if (!flag) throw new HttpError(404, "flag inconnu");
            return json(flag);
          } catch (error) {
            if (error instanceof CounterAlreadyRunningError) {
              throw new HttpError(409, error.message);
            }
            throw error;
          }
        }
        const reviewFlagCounterId = routeId(
          pathname,
          /^\/api\/review-flags\/([^/]+)\/counter-opinion$/,
        );
        if (request.method === "POST" && reviewFlagCounterId !== null) {
          const body = await readObject(request);
          const flag = deps.reviews.getFlag(reviewFlagCounterId);
          if (!flag) throw new HttpError(404, "flag inconnu");
          if (
            body.codeProvider !== undefined
            && body.codeProvider !== "claude"
            && body.codeProvider !== "codex"
          ) {
            throw new HttpError(400, "codeProvider invalide");
          }
          const codeProvider = (body.codeProvider ?? flag.code_provider) as Provider;
          const defaults = defaultReviewConfig(
            codeProvider === "claude" ? "codex" : "claude",
          );
          const model = strongReviewModel(
            body.model === undefined ? defaults.model : requiredString(body, "model"),
            "model de contre-avis",
          );
          const effort = body.effort === undefined
            ? defaults.effort
            : optionalEffort(body, defaults.provider);
          try {
            return json(deps.reviews.startCounterOpinions([reviewFlagCounterId], {
              model,
              effort: effort ?? defaults.effort,
              codeProvider,
            }), 202);
          } catch (error) {
            if (error instanceof CounterAlreadyRunningError) {
              throw new HttpError(409, error.message);
            }
            throw error;
          }
        }

        const reviewDecisionId = routeId(
          pathname,
          /^\/api\/review-decisions\/([^/]+)$/,
        );
        if (request.method === "PATCH" && reviewDecisionId !== null) {
          const body = await readObject(request);
          if (body.status !== "acked" && body.status !== "dismissed") {
            throw new HttpError(400, "statut de décision invalide");
          }
          const decision = deps.reviews.setDecisionStatus(reviewDecisionId, body.status);
          if (!decision) throw new HttpError(404, "décision inconnue");
          return json(decision);
        }

        if (request.method === "POST" && pathname === "/api/subtasks") {
          const body = await readObject(request);
          const conversationId = requiredString(body, "conversationId");
          if (!deps.conversations.get(conversationId)) {
            throw new HttpError(404, "conversation inconnue");
          }
          const provider = requiredString(body, "provider");
          if (provider !== "claude" && provider !== "codex") {
            throw new HttpError(400, "provider invalide");
          }
          const model = requiredString(body, "model");
          const effort = optionalEffort(body, provider as Provider);
          const speed = optionalSpeed(body, provider as Provider);
          const prompt = requiredString(body, "prompt");
          const label = optionalLabel(body);
          try {
            // Lancement asynchrone : on rend l'id tout de suite, le suivi passe
            // par /ws?conversation=<id> ou GET /api/subtasks/:id.
            const subtask = deps.subtasks.start({
              conversationId,
              provider: provider as Provider,
              model,
              effort,
              speed,
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

        if (request.method === "POST" && pathname === "/api/media") {
          const limit = byteLimit("PUPITRE_MEDIA_MAX_BYTES", DEFAULT_MEDIA_MAX_BYTES);
          const declaredLength = Number(request.headers.get("content-length"));
          if (Number.isFinite(declaredLength) && declaredLength > limit) {
            throw new HttpError(413, "image trop volumineuse");
          }
          const bytes = Buffer.from(await request.arrayBuffer());
          if (bytes.length === 0) throw new HttpError(400, "image vide");
          if (bytes.length > limit) throw new HttpError(413, "image trop volumineuse");
          const name = deps.media.importBytes(
            bytes,
            mediaExtension(request.headers.get("content-type")),
          );
          return json({ name }, 201);
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

        if (request.method === "GET" && pathname === "/ws") {
          const channel = url.searchParams.get("channel");
          if (channel === "quotas") {
            if (server.upgrade(request, { data: { channel: "quotas" } })) return;
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
        const { conversationId } = socket.data;
        const subscribers = sockets.get(conversationId);
        subscribers?.delete(socket);
        if (subscribers?.size === 0) sockets.delete(conversationId);
      },
      message() {},
    },
  });
}
