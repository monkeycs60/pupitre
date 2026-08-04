import type { ConversationStore } from "./stores/conversations";
import type { ProjectStore } from "./stores/projects";
import type { MediaStore } from "./media";
import type { AppEvent, StoredEvent } from "./events";
import { runClaudeTurn } from "./adapters/claude";
import { runCodexTurn } from "./adapters/codex";

type BroadcastFn = (conversationId: string, event: StoredEvent) => void;

interface ActiveTurn {
  controller: AbortController;
  done: Promise<void>;
  finish: () => void;
}

export function sweepOrphanedRuns(
  convs: ConversationStore,
  projects: ProjectStore,
): void {
  for (const project of projects.list()) {
    for (const conversation of convs.listByProject(project.id)) {
      const lastEvent = convs.listEvents(conversation.id).at(-1);
      if (lastEvent?.type === "status" && lastEvent.state === "running") {
        convs.appendEvent(conversation.id, {
          type: "status",
          state: "error",
          error: "interrompu (sidecar redémarré)",
        });
      }
    }
  }
}

export class ConversationRunner {
  private active = new Map<string, ActiveTurn>();

  constructor(
    private convs: ConversationStore,
    private projects: ProjectStore,
    private media: MediaStore,
    private broadcast: BroadcastFn,
  ) {
    sweepOrphanedRuns(convs, projects);
  }

  isRunning(conversationId: string): boolean {
    return this.active.has(conversationId);
  }

  async cancelTurn(conversationId: string): Promise<boolean> {
    const turn = this.active.get(conversationId);
    if (!turn) return false;
    turn.controller.abort();
    await turn.done;
    return true;
  }

  async runTurn(conversationId: string, prompt: string, imageNames: string[]): Promise<void> {
    if (this.active.has(conversationId)) throw new Error("un tour est déjà en cours");
    const conv = this.convs.get(conversationId);
    if (!conv) throw new Error("conversation inconnue");
    const project = this.projects.get(conv.project_id)!;
    const controller = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.active.set(conversationId, { controller, done, finish });

    const emit = (event: AppEvent) => {
      if (event.type === "session") {
        this.convs.setCliSessionId(conversationId, event.cliSessionId);
      }
      const id = this.convs.appendEvent(conversationId, event);
      this.broadcast(conversationId, { ...event, id });
    };

    try {
      emit({ type: "user-message", text: prompt, images: imageNames });
      const opts = {
        cwd: project.path,
        model: conv.model,
        effort: conv.effort ?? undefined,
        speed: conv.speed ?? undefined,
        prompt,
        cliSessionId: conv.cli_session_id,
        permissionMode: project.permission_mode,
        images: imageNames.map((name) => this.media.absolutePath(name)),
        signal: controller.signal,
      };
      if (conv.provider === "claude") await runClaudeTurn(opts, emit);
      else await runCodexTurn(opts, emit);
    } finally {
      const activeTurn = this.active.get(conversationId);
      this.active.delete(conversationId);
      activeTurn?.finish();
    }
  }
}
