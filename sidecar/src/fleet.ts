import type { StoredEvent } from "./events";
import type { ConversationRunner } from "./runner";
import type { SubtaskRunner } from "./subtasks";
import type { RoutineStore } from "./routines";
import type { ConversationStore } from "./stores/conversations";
import type { ProjectStore } from "./stores/projects";

export interface FleetItem {
  id: string;
  kind: "turn" | "subtask" | "routine";
  projectId: string;
  projectName: string;
  conversationId: string;
  title: string;
  provider: "claude" | "codex" | "grok" | "reasonix";
  model: string;
  startedAt: string;
  lastEvent: string;
  lastTool?: { toolName: string; input: unknown };
}

/* Les entrées d'outil peuvent porter un fichier entier (Write, patch) : la
   flotte est diffusée chaque seconde, seul un aperçu borné y circule. */
function previewInput(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.length > 240 ? `${value.slice(0, 240)}…` : value;
  if (Array.isArray(value)) return depth >= 2 ? [] : value.slice(0, 4).map((entry) => previewInput(entry, depth + 1));
  if (value !== null && typeof value === "object") {
    if (depth >= 2) return {};
    return Object.fromEntries(Object.entries(value).slice(0, 12).map(([key, entry]) => [key, previewInput(entry, depth + 1)]));
  }
  return value;
}

const toolCursors = new Map<string, { since: string; lastId: number; tool: FleetItem["lastTool"] }>();

function lastTool(conversations: ConversationStore, eventStream: string, since: string): FleetItem["lastTool"] {
  const cursor = toolCursors.get(eventStream);
  const base = cursor?.since === since ? cursor : { since, lastId: 0, tool: undefined };
  const { lastId, tool } = conversations.latestToolStartSince(eventStream, base.lastId, since);
  const next = { since, lastId, tool: tool ? { toolName: tool.toolName, input: previewInput(tool.input) } : base.tool };
  toolCursors.set(eventStream, next);
  return next.tool;
}

function eventLabel(event: StoredEvent | undefined): string {
  if (!event) return "démarrage";
  switch (event.type) {
    case "user-message": return "demande envoyée";
    case "text-delta":
    case "text-final": return "réponse du modèle";
    case "reasoning-delta": return "réflexion";
    case "turn-phase": return `phase · ${event.phase}`;
    case "tool-start": return `outil · ${event.toolName}`;
    case "tool-end": return "outil terminé";
    case "turn-timing": return event.phase === "first-response" ? "premier retour" : event.phase;
    case "usage": return "usage reçu";
    case "status": return event.state === "running" ? "en cours" : event.state;
    case "session": return "session ouverte";
    case "rate-limit": return "quota actualisé";
    default: return event.type;
  }
}

export function fleetSnapshot(deps: {
  runner: ConversationRunner;
  subtasks: SubtaskRunner;
  conversations: ConversationStore;
  projects: ProjectStore;
  routineStore: RoutineStore;
}): FleetItem[] {
  const items: FleetItem[] = [];
  for (const active of deps.runner.activeTurns()) {
    const conversation = deps.conversations.get(active.conversationId);
    if (!conversation) continue;
    const project = deps.projects.get(conversation.project_id);
    if (!project) continue;
    const routine = conversation.routine_id
      ? deps.routineStore.get(conversation.routine_id)
      : null;
    items.push({
      id: `${routine ? "routine" : "turn"}:${conversation.id}`,
      kind: routine ? "routine" : "turn",
      projectId: project.id,
      projectName: project.name,
      conversationId: conversation.id,
      title: routine?.name ?? conversation.title,
      provider: conversation.provider,
      model: conversation.model,
      startedAt: active.startedAt,
      lastEvent: eventLabel(deps.conversations.latestEvent(conversation.id)),
      lastTool: lastTool(deps.conversations, conversation.id, active.startedAt),
    });
  }
  for (const subtask of deps.subtasks.activeSubtasks()) {
    const conversation = deps.conversations.get(subtask.conversation_id);
    if (!conversation) continue;
    const project = deps.projects.get(conversation.project_id);
    if (!project) continue;
    items.push({
      id: `subtask:${subtask.id}`,
      kind: "subtask",
      projectId: project.id,
      projectName: project.name,
      conversationId: conversation.id,
      title: subtask.label ?? subtask.prompt.slice(0, 80),
      provider: subtask.provider,
      model: subtask.model,
      startedAt: subtask.created_at,
      lastEvent: eventLabel(deps.conversations.latestEvent(subtask.id)),
      lastTool: lastTool(deps.conversations, subtask.id, subtask.created_at),
    });
  }
  const live = new Set(items.map((item) => item.kind === "subtask" ? item.id.slice("subtask:".length) : item.conversationId));
  for (const stream of toolCursors.keys()) if (!live.has(stream)) toolCursors.delete(stream);
  return items.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
}
