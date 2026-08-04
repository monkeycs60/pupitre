import type { ServerWebSocket } from "bun";
import { existsSync } from "node:fs";
import type { Provider, StoredEvent } from "./events";
import type { MediaStore } from "./media";
import type { ConversationRunner } from "./runner";
import type { ConversationStore } from "./stores/conversations";
import type { ProjectStore } from "./stores/projects";
import type { PresetInput, PresetStore } from "./stores/presets";
import type { SettingsStore } from "./stores/settings";
import type { QuotaTracker } from "./quotas";
import { SubtaskLimitError, type SubtaskRunner } from "./subtasks";

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

export const HANDOFF_PROMPT = [
  "Prépare une passation concise pour un autre modèle qui va reprendre cette conversation.",
  "Résume l'objectif, les décisions prises, l'état actuel, les fichiers importants,",
  "les vérifications déjà faites et les prochaines étapes. N'utilise aucun outil,",
  "ne poursuis pas l'implémentation et retourne uniquement le résumé de passation.",
].join(" ");

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function empty(status: number): Response {
  return new Response(null, { status });
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

function optionalImages(body: Record<string, unknown>): string[] {
  const value = body.images;
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new HttpError(400, "champ images invalide");
  }
  return value as string[];
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
  return {
    name,
    provider,
    model: requiredString(body, "model"),
    effort: optionalEffort(body, provider),
    speed: optionalSpeed(body, provider),
    orchestrator: optionalBoolean(body, "orchestrator", true),
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
          && !origin.startsWith("http://localhost:")
          && !origin.startsWith("http://127.0.0.1:")
        ) {
          throw new HttpError(403, "origine interdite");
        }

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
          const images = optionalImages(body);
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
          if (deps.runner.isRunning(conversationModelId)) {
            throw new HttpError(409, "un tour est déjà en cours");
          }
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
        }

        const conversationHandoffId = routeId(
          pathname,
          /^\/api\/conversations\/([^/]+)\/handoff$/,
        );
        if (request.method === "POST" && conversationHandoffId !== null) {
          const source = deps.conversations.get(conversationHandoffId);
          if (!source) throw new HttpError(404, "conversation inconnue");
          if (deps.runner.isRunning(source.id)) {
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
          const lastEventId = deps.conversations.listEvents(source.id).at(-1)?.id ?? 0;

          try {
            await deps.runner.runTurn(source.id, HANDOFF_PROMPT, []);
          } catch (error) {
            if (error instanceof Error && error.message.includes("déjà en cours")) {
              throw new HttpError(409, error.message);
            }
            throw error;
          }
          const handoffEvents = deps.conversations.listEvents(source.id)
            .filter((event) => event.id > lastEventId);
          const terminal = handoffEvents.findLast((event) => event.type === "status");
          if (terminal?.type === "status" && terminal.state === "error") {
            throw new HttpError(502, terminal.error ?? "échec du résumé de passation");
          }
          const summary = handoffEvents
            .filter((event) => event.type === "text-final")
            .map((event) => event.text)
            .join("\n")
            .trim();
          if (!summary) throw new HttpError(502, "résumé de passation vide");

          const continuation = deps.conversations.create({
            projectId: source.project_id,
            provider,
            model,
            effort,
            speed,
            orchestrator,
            continuedFrom: source.id,
            firstMessage: `Suite — ${source.title}`,
          });
          const seed = [
            `Voici la passation de la conversation ${source.title} :`,
            "",
            summary,
            "",
            "Prends ce contexte comme point de départ et confirme brièvement la reprise.",
          ].join("\n");
          await deps.runner.runTurn(continuation.id, seed, []);
          return json(deps.conversations.get(continuation.id), 201);
        }

        const messageConversationId = routeId(
          pathname,
          /^\/api\/conversations\/([^/]+)\/messages$/,
        );
        if (request.method === "POST" && messageConversationId !== null) {
          if (!deps.conversations.get(messageConversationId)) {
            throw new HttpError(404, "conversation inconnue");
          }
          const body = await readObject(request);
          const message = requiredString(body, "message");
          const images = optionalImages(body);
          if (deps.runner.isRunning(messageConversationId)) {
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
          const bytes = Buffer.from(await request.arrayBuffer());
          if (bytes.length === 0) throw new HttpError(400, "image vide");
          const name = deps.media.importFromBase64(
            bytes.toString("base64"),
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
          return new Response(file);
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
