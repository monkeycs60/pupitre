import type { ServerWebSocket } from "bun";
import { existsSync } from "node:fs";
import type { AppEvent, Provider } from "./events";
import type { MediaStore } from "./media";
import type { ConversationRunner } from "./runner";
import type { ConversationStore } from "./stores/conversations";
import type { ProjectStore } from "./stores/projects";

type EventListener = (conversationId: string, event: AppEvent) => void;

export class ConversationEventBus {
  private listeners = new Set<EventListener>();

  broadcast = (conversationId: string, event: AppEvent): void => {
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
}

interface WebSocketData {
  conversationId: string;
}

const EFFORTS_BY_PROVIDER = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["low", "medium", "high", "xhigh"],
} as const satisfies Record<Provider, readonly string[]>;

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
          const message = requiredString(body, "message");
          const images = optionalImages(body);
          const conversation = deps.conversations.create({
            projectId,
            provider: provider as Provider,
            model,
            effort,
            firstMessage: message,
          });
          void deps.runner.runTurn(conversation.id, message, images)
            .catch((error) => console.error("Échec du tour", error));
          return json(conversation, 201);
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
          const cancelled = await deps.runner.cancelTurn(cancelConversationId);
          if (!cancelled) throw new HttpError(409, "aucun tour en cours");
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

        if (request.method === "GET" && pathname === "/ws") {
          const conversationId = url.searchParams.get("conversation");
          if (!conversationId || !deps.conversations.get(conversationId)) {
            throw new HttpError(404, "conversation inconnue");
          }
          if (server.upgrade(request, { data: { conversationId } })) {
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
        const { conversationId } = socket.data;
        let subscribers = sockets.get(conversationId);
        if (!subscribers) {
          subscribers = new Set();
          sockets.set(conversationId, subscribers);
        }
        subscribers.add(socket);
      },
      close(socket) {
        const { conversationId } = socket.data;
        const subscribers = sockets.get(conversationId);
        subscribers?.delete(socket);
        if (subscribers?.size === 0) sockets.delete(conversationId);
      },
      message() {},
    },
  });
}
