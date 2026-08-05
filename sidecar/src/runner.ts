import type { ConversationStore } from "./stores/conversations";
import type { ProjectStore } from "./stores/projects";
import type { MediaStore } from "./media";
import type { AppEvent, StoredEvent } from "./events";
import { runClaudeTurn } from "./adapters/claude";
import { runCodexTurn } from "./adapters/codex";
import { runCodexAppServerTurn } from "./adapters/codex-app-server";
import type { QuotaTracker } from "./quotas";
import { ConversationActivity } from "./conversation-activity";
import type { GitProjectService, GitTurnTracking } from "./git";
import type { SkillInventory } from "./skills";
import type { AppNotification } from "./stores/notifications";

type BroadcastFn = (conversationId: string, event: StoredEvent) => void;

interface ActiveTurn {
  controller: AbortController;
  done: Promise<void>;
  finish: () => void;
  startedAt: string;
}

export interface ActiveTurnSnapshot {
  conversationId: string;
  startedAt: string;
}

export interface TurnOutcome {
  state: "done" | "error";
  error?: string;
}

export function sweepOrphanedRuns(
  convs: ConversationStore,
): void {
  convs.sweepOrphanedRuns();
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
     * éphémère. C'est ce port que le bridge MCP rappellera — d'où l'absence de
     * valeur par défaut : un fournisseur oublié donnait `0`, donc un bridge qui
     * appelait un port mort, et des délégations qui expiraient 15 min plus tard
     * sans autre signal.
     */
    private port: () => number,
    private git?: GitProjectService,
    private skills?: SkillInventory,
    private notify?: (notification: Omit<AppNotification, "id" | "created_at">) => void,
    private longTaskThresholdMs: () => number = () => 120_000,
    readonly activity = new ConversationActivity(),
  ) {
    sweepOrphanedRuns(convs);
  }

  isRunning(conversationId: string): boolean {
    return this.active.has(conversationId);
  }

  activeTurns(): ActiveTurnSnapshot[] {
    return [...this.active.entries()].map(([conversationId, turn]) => ({
      conversationId,
      startedAt: turn.startedAt,
    }));
  }

  async cancelTurn(conversationId: string): Promise<boolean> {
    const turn = this.active.get(conversationId);
    if (!turn) return false;
    turn.controller.abort();
    await turn.done;
    return true;
  }

  async runTurn(
    conversationId: string,
    prompt: string,
    imageNames: string[],
  ): Promise<TurnOutcome> {
    const conv = this.convs.get(conversationId);
    if (!conv) throw new Error("conversation inconnue");
    const releaseActivity = this.activity.acquire(conversationId, "turn");
    const project = this.projects.get(conv.project_id)!;
    let gitTracking: GitTurnTracking | null = null;
    try {
      gitTracking = this.git?.beginTurn(project.id) ?? null;
    } catch {
      // Un projet hors Git ne doit jamais empêcher le tour.
    }
    const controller = new AbortController();
    const startedAt = new Date().toISOString();
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.active.set(conversationId, { controller, done, finish, startedAt });
    let outcome: TurnOutcome = {
      state: "error",
      error: "le provider n'a pas publié de statut terminal",
    };
    const startedAtMs = Date.now();
    let firstResponseAt: string | undefined;

    const persist = (event: AppEvent) => {
      // Les events de quota restent des events de conversation (replay intact)
      // ET alimentent le tracker global au passage.
      this.quotas.ingest(event);
      const id = this.convs.appendEvent(conversationId, event);
      this.broadcast(conversationId, { ...event, id });
    };

    const emit = (event: AppEvent) => {
      if (
        firstResponseAt === undefined
        && (event.type === "text-delta"
          || event.type === "text-final"
          || event.type === "tool-start")
      ) {
        firstResponseAt = new Date().toISOString();
        persist({
          type: "turn-timing",
          phase: "first-response",
          startedAt,
          firstResponseAt,
        });
      }
      if (event.type === "status" && event.state !== "running") {
        outcome = { state: event.state, ...(event.error ? { error: event.error } : {}) };
        persist({
          type: "turn-timing",
          phase: "completed",
          startedAt,
          ...(firstResponseAt ? { firstResponseAt } : {}),
          completedAt: new Date().toISOString(),
        });
      }
      if (event.type === "session") {
        this.convs.setCliSessionId(conversationId, event.cliSessionId);
      }
      persist(event);
    };

    try {
      emit({ type: "user-message", text: prompt, images: imageNames });
      emit({ type: "turn-timing", phase: "started", startedAt });
      // Câblage du bridge MCP `conductor`, par tour : seule une conversation
      // orchestratrice peut déléguer. Les tours de sous-tâches passent par
      // SubtaskRunner, qui ne construit JAMAIS ce champ (garde de profondeur).
      let conductor: { port: number; conversationId: string } | undefined;
      if (conv.orchestrator) {
        const port = this.port();
        if (!Number.isInteger(port) || port <= 0) {
          // Échec immédiat et lisible plutôt qu'un tour lancé vers un bridge
          // injoignable : le CLI aurait tourné, appelé `delegate`, et attendu.
          const message = `port du sidecar indisponible (${port}) : `
            + "impossible de câbler le bridge conductor";
          emit({ type: "status", state: "error", error: message });
          throw new Error(message);
        }
        conductor = { port, conversationId };
      }
      const opts = {
        cwd: project.path,
        model: conv.model,
        effort: conv.effort ?? undefined,
        speed: conv.speed ?? undefined,
        prompt: this.skills?.augmentPrompt(prompt, project.id) ?? prompt,
        cliSessionId: conv.cli_session_id,
        permissionMode: project.permission_mode,
        images: imageNames.map((name) => this.media.absolutePath(name)),
        signal: controller.signal,
        ...(conductor ? { conductor } : {}),
      };
      if (conv.provider === "claude") await runClaudeTurn(opts, emit);
      // Codex passe par l'app-server (vrais deltas, quotas natifs) ; le chemin
      // `codex exec` historique reste accessible via PUPITRE_CODEX_MODE=exec.
      else if (process.env.PUPITRE_CODEX_MODE === "exec") await runCodexTurn(opts, emit);
      else await runCodexAppServerTurn(opts, emit);
    } finally {
      try {
        if (this.git && gitTracking) this.git.finishTurn(gitTracking, conversationId);
      } catch (error) {
        // J1 est volontairement best effort : une lecture Git cassée ne change
        // ni le résultat provider ni le statut terminal du tour.
        console.error("Traçage des commits impossible", error);
      }
      try {
        this.convs.compactTextDeltas(conversationId);
      } catch (error) {
        // Le tour et son flux sont déjà persistés : une compaction opportuniste
        // ne doit jamais transformer un succès provider en échec utilisateur.
        console.error("Compaction des deltas impossible", error);
      }
      const elapsedMs = Date.now() - startedAtMs;
      if (!conv.routine_id && elapsedMs >= this.longTaskThresholdMs()) {
        this.notify?.({
          kind: "long-task",
          title: outcome.state === "done" ? "Tâche longue terminée" : "Tâche longue en échec",
          body: `${conv.title} · ${Math.round(elapsedMs / 1_000)} s`,
          conversation_id: conversationId,
        });
      }
      const activeTurn = this.active.get(conversationId);
      this.active.delete(conversationId);
      activeTurn?.finish();
      releaseActivity();
    }
    return outcome;
  }
}
