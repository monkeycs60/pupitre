import type { ConversationStore } from "./stores/conversations";
import type { Project, ProjectStore } from "./stores/projects";
import type { MediaStore } from "./media";
import type { AppEvent, MediaAttachment, StoredEvent } from "./events";
import { runClaudeTurn } from "./adapters/claude";
import { runCodexTurn } from "./adapters/codex";
import { runCodexAppServerTurn } from "./adapters/codex-app-server";
import type { QuotaTracker } from "./quotas";
import { ConversationActivity } from "./conversation-activity";
import type { GitProjectService, GitTurnTracking } from "./git";
import type { SkillInventory } from "./skills";
import type { AppNotification } from "./stores/notifications";
import { generateDigest, shouldRefreshDigest } from "./conversation-digest";
import { DEFAULT_ACTION_FORMAT, withActionFormat } from "./response-format";
import { claudeServerDefinitions } from "./mcp-inventory";
import type { ActionFormat } from "./response-format";
import { conversationCwd } from "./workspace";
import type { SteerFn } from "./adapters/types";

type BroadcastFn = (conversationId: string, event: StoredEvent) => void;

interface ActiveTurn {
  controller: AbortController;
  done: Promise<void>;
  finish: () => void;
  startedAt: string;
  steerReady: Promise<SteerFn> | null;
  persistSteer: (event: Extract<AppEvent, { type: "user-message" }>) => void;
}

function attachmentPrompt(
  attachments: MediaAttachment[],
  media: MediaStore,
): string {
  if (attachments.length === 0) return "";
  const lines = attachments.map((attachment) => {
    const path = media.absolutePath(attachment.name);
    return `- ${attachment.originalName} (${attachment.mimeType}, ${attachment.size} octets) : ${path}`;
  });
  return "\n\n[Pièces jointes disponibles]\n" + lines.join("\n")
    + "\nConsulte les fichiers joints avec les outils disponibles si nécessaire.";
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

/**
 * Traduit la sélection MCP d'un projet en option de tour. `null` quand le
 * projet ne filtre pas : le CLI garde alors son comportement natif.
 */
function selectedMcpServers(
  project: Project,
): { mcpServers: Record<string, unknown>; mcpAllowed: string[] } | null {
  if (project.mcp_servers === null) return null;
  const available = claudeServerDefinitions(project.path);
  const kept = Object.fromEntries(
    project.mcp_servers
      .filter((name) => name in available)
      .map((name) => [name, available[name]]),
  );
  // `mcpAllowed` porte TOUS les noms retenus, y compris ceux de Codex qui n'ont
  // pas de définition côté Claude.
  return { mcpServers: kept, mcpAllowed: project.mcp_servers };
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
    /** Lu à chaque tour : le réglage peut changer sans redémarrer le sidecar. */
    private actionFormat: () => ActionFormat = () => DEFAULT_ACTION_FORMAT,
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

  /** Ajoute une précision au tour provider actif, s'il l'accepte encore. */
  async steerTurn(
    conversationId: string,
    prompt: string,
    imageNames: string[],
    attachments: MediaAttachment[] = [],
  ): Promise<boolean> {
    const active = this.active.get(conversationId);
    if (!active?.steerReady) return false;

    const steer = await Promise.race([
      active.steerReady,
      active.done.then(() => null),
    ]);
    if (!steer) return false;

    const conv = this.convs.get(conversationId);
    const project = conv ? this.projects.get(conv.project_id) : null;
    if (!conv || !project) return false;
    const augmented = this.skills?.augmentPrompt(prompt, project.id, {
      cwd: conversationCwd(project, conv),
      projectPath: project.path,
    }) ?? prompt;
    const accepted = await steer({
      prompt: augmented + attachmentPrompt(attachments, this.media),
      images: imageNames.map((name) => this.media.absolutePath(name)),
    });
    if (!accepted) {
      await active.done;
      return false;
    }

    active.persistSteer({
      type: "user-message",
      text: prompt,
      images: imageNames,
      ...(attachments.length > 0 ? { attachments } : {}),
      steering: true,
    });
    return true;
  }

  async runTurn(
    conversationId: string,
    prompt: string,
    imageNames: string[],
    attachments: MediaAttachment[] = [],
    options: { preamble?: string } = {},
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
    const supportsSteer = conv.provider === "claude"
      || (conv.provider === "codex" && process.env.PUPITRE_CODEX_MODE !== "exec");
    let acceptSteer: ((steer: SteerFn) => void) | null = null;
    const steerReady = supportsSteer
      ? new Promise<SteerFn>((resolve) => { acceptSteer = resolve; })
      : null;
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

    this.active.set(conversationId, {
      controller,
      done,
      finish,
      startedAt,
      steerReady,
      persistSteer: persist,
    });

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
      emit({
        type: "user-message",
        text: prompt,
        images: imageNames,
        ...(attachments.length > 0 ? { attachments } : {}),
      });
      emit({ type: "turn-timing", phase: "started", startedAt });
      // Câblage du bridge MCP `conductor`, par tour : seule une conversation
      // orchestratrice peut déléguer. Les tours de sous-tâches passent par
      // SubtaskRunner, qui ne construit JAMAIS ce champ (garde de profondeur).
      let conductor: { port: number; conversationId: string } | undefined;
      let pupitre: { port: number; conversationId: string } | undefined;
      const sidecarPort = this.port();
      if (Number.isInteger(sidecarPort) && sidecarPort > 0) {
        pupitre = { port: sidecarPort, conversationId };
      }
      if (conv.orchestrator) {
        if (!Number.isInteger(sidecarPort) || sidecarPort <= 0) {
          // Échec immédiat et lisible plutôt qu'un tour lancé vers un bridge
          // injoignable : le CLI aurait tourné, appelé `delegate`, et attendu.
          const message = `port du sidecar indisponible (${sidecarPort}) : `
            + "impossible de câbler le bridge conductor";
          emit({ type: "status", state: "error", error: message });
          throw new Error(message);
        }
        conductor = { port: sidecarPort, conversationId };
      }
      const permissionMode = conv.permission_mode ?? project.permission_mode;
      const cwd = conversationCwd(project, conv)
      const providerPrompt = (options.preamble ? `${options.preamble}\n\n---\n\n` : "")
        + (this.skills?.augmentPrompt(prompt, project.id, {
          cwd: conversationCwd(project, conv),
          projectPath: project.path,
        }) ?? prompt)
        + attachmentPrompt(attachments, this.media);
      const opts = {
        cwd,
        // Depuis un worktree, le dépôt principal doit rester lisible : le
        // `.git` du worktree n'est qu'un renvoi vers lui.
        extraWorkspaceRoots: cwd === project.path ? undefined : [project.path],
        model: conv.model,
        effort: conv.effort ?? undefined,
        speed: conv.speed ?? undefined,
        prompt: withActionFormat(providerPrompt, this.actionFormat()),
        cliSessionId: conv.cli_session_id,
        permissionMode,
        filesystemScope: project.filesystem_scope,
        ...(conv.provider === "codex" && permissionMode === "plan"
          ? { sandboxMode: "read-only" as const }
          : {}),
        images: imageNames.map((name) => this.media.absolutePath(name)),
        attachments,
        signal: controller.signal,
        ...(conductor ? { conductor } : {}),
        ...(pupitre ? { pupitre } : {}),
        ...(selectedMcpServers(project) ?? {}),
        ...(supportsSteer && acceptSteer ? { registerSteer: acceptSteer } : {}),
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
      // Best effort et hors chemin critique : le tour est déjà rendu, le digest
      // arrive quand il arrive. Un échec ne laisse que l'ancien titre.
      if (outcome.state === "done") void this.refreshDigest(conversationId, project.path, persist);
    }
    return outcome;
  }

  /** Régénère titre + résumé si le palier est atteint et le titre non figé. */
  private async refreshDigest(
    conversationId: string,
    cwd: string,
    persist: (event: AppEvent) => void,
  ): Promise<void> {
    try {
      const conv = this.convs.get(conversationId);
      if (!conv || conv.title_locked) return;
      const turn = this.convs.turnCount(conversationId);
      if (!shouldRefreshDigest(turn, conv.digest_turn)) return;
      const digest = await generateDigest(this.convs.digestSource(conversationId), cwd);
      if (!digest) return;
      const updated = this.convs.updateDigest(conversationId, digest, turn);
      if (!updated) return;
      persist({ type: "conversation-digest", title: updated.title, summary: updated.summary });
    } catch (error) {
      console.error("Rafraîchissement du digest impossible", error);
    }
  }
}
