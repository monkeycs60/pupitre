import type { ConversationStore } from "./stores/conversations";
import type { ProjectStore } from "./stores/projects";
import type { MediaStore } from "./media";
import type { AppEvent, StoredEvent } from "./events";
import { runClaudeTurn } from "./adapters/claude";
import { runCodexTurn } from "./adapters/codex";
import { runCodexAppServerTurn } from "./adapters/codex-app-server";
import type { QuotaTracker } from "./quotas";

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
    private quotas: QuotaTracker,
    /**
     * Port HTTP du sidecar, lu à chaque tour (et non capturé au démarrage) : le
     * serveur est construit APRÈS le runner, et en test il écoute sur un port
     * éphémère. C'est ce port que le bridge MCP rappellera.
     */
    private port: () => number = () => 0,
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
      // Les events de quota restent des events de conversation (replay intact)
      // ET alimentent le tracker global au passage.
      this.quotas.ingest(event);
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
        // Câblage du bridge MCP `conductor`, par tour : seule une conversation
        // orchestratrice peut déléguer. Les tours de sous-tâches passent par
        // SubtaskRunner, qui ne construit JAMAIS ce champ (garde de profondeur).
        ...(conv.orchestrator
          ? { conductor: { port: this.port(), conversationId: conversationId } }
          : {}),
      };
      if (conv.provider === "claude") await runClaudeTurn(opts, emit);
      // Codex passe par l'app-server (vrais deltas, quotas natifs) ; le chemin
      // `codex exec` historique reste accessible via PUPITRE_CODEX_MODE=exec.
      else if (process.env.PUPITRE_CODEX_MODE === "exec") await runCodexTurn(opts, emit);
      else await runCodexAppServerTurn(opts, emit);
    } finally {
      const activeTurn = this.active.get(conversationId);
      this.active.delete(conversationId);
      activeTurn?.finish();
    }
  }
}
