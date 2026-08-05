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
  provider: "claude" | "codex";
  model: string;
  startedAt: string;
  lastEvent: string;
}

function eventLabel(event: StoredEvent | undefined): string {
  if (!event) return "démarrage";
  switch (event.type) {
    case "user-message": return "demande envoyée";
    case "text-delta":
    case "text-final": return "réponse du modèle";
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
      lastEvent: eventLabel(deps.conversations.listEvents(conversation.id).at(-1)),
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
      lastEvent: eventLabel(deps.conversations.listEvents(subtask.id).at(-1)),
    });
  }
  return items.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
}
