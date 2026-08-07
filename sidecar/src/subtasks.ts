import type { Database } from "bun:sqlite";
import type { AppEvent, Provider, StoredEvent } from "./events";
import type { ConversationStore } from "./stores/conversations";
import type { ProjectStore } from "./stores/projects";
import type { QuotaTracker } from "./quotas";
import { runClaudeTurn } from "./adapters/claude";
import { runCodexTurn } from "./adapters/codex";
import { runCodexAppServerTurn } from "./adapters/codex-app-server";
import type { FilesystemScope } from "./access";

/**
 * Nombre maximum de sous-tâches simultanées PAR conversation parente.
 *
 * Garde-fou de concurrence : un orchestrateur qui part en boucle (ou un
 * `delegate_parallel` trop large) spawnerait autant de CLIs que d'appels, avec
 * autant de process, de quota consommé et d'écritures concurrentes dans le même
 * working directory. Au-delà de la limite, `start()` lève `SubtaskLimitError`
 * et l'API HTTP répond 429 : c'est à l'appelant (le bridge MCP de D2) de
 * séquencer ses délégations. La limite est par conversation, pas globale : deux
 * conversations peuvent orchestrer en parallèle sans se gêner.
 */
export const MAX_CONCURRENT_SUBTASKS = 4;

export type SubtaskStatus = "running" | "done" | "error";

export interface Subtask {
  id: string;
  conversation_id: string;
  provider: Provider;
  model: string;
  effort: string | null;
  speed: "standard" | "fast" | null;
  prompt: string;
  label: string | null;
  status: SubtaskStatus;
  created_at: string;
  updated_at: string;
}

export interface SubtaskInput {
  conversationId: string;
  provider: Provider;
  model: string;
  effort?: string | null;
  speed?: "standard" | "fast" | null;
  prompt: string;
  label?: string | null;
  /** Force les deux adapters en lecture seule pour les tâches de jugement. */
  readOnly?: boolean;
}

export interface SubtaskResult {
  status: SubtaskStatus;
  resultText: string;
  /**
   * Message du dernier événement terminal en erreur (`annulé`, stderr du CLI,
   * exception…), ou null si la sous-tâche ne s'est pas terminée en échec. Un
   * sub-agent qui plante n'écrit souvent AUCUN `text-final` : sans ce champ,
   * l'orchestrateur et la carte UI n'ont qu'un « ÉCHEC » sans cause.
   */
  error: string | null;
  subtask: Subtask;
}

/** Levée par `start()` quand la conversation a déjà MAX_CONCURRENT_SUBTASKS tours en vol. */
export class SubtaskLimitError extends Error {}

type BroadcastFn = (conversationId: string, event: StoredEvent) => void;

/**
 * Message du DERNIER `status` du flux, s'il est en erreur. On ne remonte pas
 * plus loin : une erreur suivie d'un statut terminal sain n'est pas un échec.
 */
function lastError(events: StoredEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type !== "status") continue;
    return event.state === "error" ? event.error ?? null : null;
  }
  return null;
}

export class SubtaskStore {
  constructor(private db: Database) {}

  create(input: SubtaskInput): Subtask {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.query(
      `INSERT INTO subtasks
         (id, conversation_id, provider, model, effort, speed, prompt, label,
          status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
    ).run(
      id,
      input.conversationId,
      input.provider,
      input.model,
      input.effort ?? null,
      input.speed ?? null,
      input.prompt,
      input.label ?? null,
      now,
      now,
    );
    return this.get(id)!;
  }

  get(id: string): Subtask | null {
    return this.db.query("SELECT * FROM subtasks WHERE id = ?").get(id) as Subtask | null;
  }

  listByConversation(conversationId: string): Subtask[] {
    return this.db.query(
      "SELECT * FROM subtasks WHERE conversation_id = ? ORDER BY created_at, id",
    ).all(conversationId) as Subtask[];
  }

  setStatus(id: string, status: SubtaskStatus): void {
    this.db.query("UPDATE subtasks SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, new Date().toISOString(), id);
  }

  listRunning(): Subtask[] {
    return this.db.query("SELECT * FROM subtasks WHERE status = 'running'").all() as Subtask[];
  }
}

export class SubtaskRunner {
  private store: SubtaskStore;
  /** Subtasks en vol dans CE process, par conversation parente (base de la limite). */
  private active = new Map<string, Set<string>>();
  /** Promesse de fin par subtask, consommée par waitResult. */
  private runs = new Map<string, Promise<void>>();
  /** Annulation par subtask (POST /api/subtasks/:id/cancel), en vol seulement. */
  private controllers = new Map<string, AbortController>();

  constructor(
    db: Database,
    private convs: ConversationStore,
    private projects: ProjectStore,
    private broadcast: BroadcastFn,
    private quotas: QuotaTracker,
  ) {
    this.store = new SubtaskStore(db);
    this.sweepOrphaned();
  }

  get(id: string): Subtask | null {
    return this.store.get(id);
  }

  listByConversation(conversationId: string): Subtask[] {
    return this.store.listByConversation(conversationId);
  }

  runningCount(conversationId: string): number {
    return this.active.get(conversationId)?.size ?? 0;
  }

  activeSubtasks(): Subtask[] {
    return [...this.controllers.keys()]
      .flatMap((id) => {
        const subtask = this.store.get(id);
        return subtask ? [subtask] : [];
      });
  }

  /**
   * Crée la subtask, appende le `subtask-ref` au parent, puis lance le tour en
   * arrière-plan. Retourne dès que la ligne existe : l'appelant récupère l'id
   * tout de suite et suit la suite par WS ou par `waitResult`.
   *
   * Aucun verrou de conversation n'est pris : les subtasks tournent
   * délibérément EN PARALLÈLE du tour parent (c'est le parent qui les demande,
   * il est donc lui-même en cours d'exécution).
   */
  start(input: SubtaskInput): Subtask {
    const conversation = this.convs.get(input.conversationId);
    if (!conversation) throw new Error("conversation inconnue");
    const project = this.projects.get(conversation.project_id);
    if (!project) throw new Error("projet inconnu");
    if (this.runningCount(input.conversationId) >= MAX_CONCURRENT_SUBTASKS) {
      throw new SubtaskLimitError(
        `limite de ${MAX_CONCURRENT_SUBTASKS} sous-tâches simultanées atteinte`,
      );
    }

    const subtask = this.store.create(input);
    let siblings = this.active.get(input.conversationId);
    if (!siblings) {
      siblings = new Set();
      this.active.set(input.conversationId, siblings);
    }
    siblings.add(subtask.id);

    // Trace dans le fil parent : la carte de sub-agent de l'UI part de là.
    const ref: AppEvent = {
      type: "subtask-ref",
      subtaskId: subtask.id,
      provider: subtask.provider,
      model: subtask.model,
      ...(subtask.label ? { label: subtask.label } : {}),
    };
    const refId = this.convs.appendEvent(input.conversationId, ref);
    this.broadcast(input.conversationId, { ...ref, id: refId });

    const controller = new AbortController();
    this.controllers.set(subtask.id, controller);
    const readOnly = input.readOnly === true;
    const run = this.run(
      subtask,
      project.path,
      project.filesystem_scope,
      readOnly ? "plan" : (conversation.permission_mode ?? project.permission_mode),
      controller.signal,
      readOnly,
    )
      .catch((error) => console.error("Échec d'une sous-tâche", error))
      .finally(() => {
        this.controllers.delete(subtask.id);
        // La promesse ne sert plus à rien une fois réglée : la garder ferait
        // grossir la table à chaque délégation d'une session longue. `cancel` et
        // `waitResult` traitent l'absence d'entrée comme « déjà terminée » —
        // c'est déjà le cas pour une subtask d'un process précédent.
        this.runs.delete(subtask.id);
        siblings!.delete(subtask.id);
        if (siblings!.size === 0) this.active.delete(input.conversationId);
      });
    this.runs.set(subtask.id, run);
    return subtask;
  }

  /**
   * Annule une sous-tâche en vol. Retourne false si elle est déjà terminée (ou
   * inconnue de ce process). Le tour se clôt en `error: annulé` comme un tour
   * de conversation annulé.
   */
  async cancel(subtaskId: string): Promise<boolean> {
    const controller = this.controllers.get(subtaskId);
    if (!controller) return false;
    controller.abort();
    await this.runs.get(subtaskId);
    return true;
  }

  /**
   * Annule TOUTES les sous-tâches en vol d'une conversation parente et rend
   * leur nombre. Appelé quand on annule le tour parent : sans ça, tuer
   * l'orchestrateur laissait ses sub-agents tourner (process, quota et
   * écritures dans le working directory) sans plus personne pour lire leur
   * résultat.
   */
  async cancelByConversation(conversationId: string): Promise<number> {
    const ids = [...(this.active.get(conversationId) ?? [])];
    const cancelled = await Promise.all(ids.map((id) => this.cancel(id)));
    return cancelled.filter(Boolean).length;
  }

  /** Attend la fin de la subtask (si elle tourne dans ce process) puis rend son résultat. */
  async waitResult(subtaskId: string): Promise<SubtaskResult | null> {
    await this.runs.get(subtaskId);
    return this.result(subtaskId);
  }

  /** Snapshot immédiat, sans attendre : statut courant + résultat partiel. */
  result(subtaskId: string): SubtaskResult | null {
    const subtask = this.store.get(subtaskId);
    if (!subtask) return null;
    const events = this.convs.listEvents(subtaskId);
    const resultText = events
      .flatMap((event) => (event.type === "text-final" ? [event.text] : []))
      .join("\n");
    return { status: subtask.status, resultText, error: lastError(events), subtask };
  }

  private async run(
    subtask: Subtask,
    cwd: string,
    filesystemScope: FilesystemScope,
    permissionMode: string,
    signal: AbortSignal,
    readOnly = false,
  ): Promise<void> {
    // Objet mutable plutôt qu'une variable locale : `emit` est une closure, et
    // l'analyse de flux de TS ne suit pas les affectations faites dedans.
    const outcome: { terminal: SubtaskStatus | null } = { terminal: null };
    const emit = (event: AppEvent) => {
      if (event.type === "status" && event.state !== "running") {
        outcome.terminal = event.state;
      }
      this.quotas.ingest(event);
      // Les events de la subtask vivent dans la table events sous SON id : le
      // replay HTTP et le WS par conversation marchent tels quels.
      const id = this.convs.appendEvent(subtask.id, event);
      this.broadcast(subtask.id, { ...event, id });
    };

    try {
      emit({ type: "user-message", text: subtask.prompt, images: [] });
      const opts = {
        cwd,
        model: subtask.model,
        effort: subtask.effort ?? undefined,
        speed: subtask.speed ?? undefined,
        prompt: subtask.prompt,
        cliSessionId: null, // une subtask est un one-shot : jamais de reprise
        permissionMode,
        filesystemScope,
        images: [],
        signal,
        ...(readOnly ? { sandboxMode: "read-only" as const } : {}),
        // GARDE DE PROFONDEUR : pas de `conductor` ici, et il n'y a aucun
        // chemin pour en ajouter un. Un sub-agent ne voit donc pas les outils
        // de délégation et ne peut pas créer de sous-sous-tâche — la
        // récursion est structurellement impossible, pas simplement découragée.
      };
      if (subtask.provider === "claude") await runClaudeTurn(opts, emit);
      else if (process.env.PUPITRE_CODEX_MODE === "exec") await runCodexTurn(opts, emit);
      else await runCodexAppServerTurn(opts, emit);
      if (outcome.terminal === null) {
        emit({ type: "status", state: "error", error: "tour terminé sans statut" });
      }
    } catch (error) {
      emit({ type: "status", state: "error", error: String(error) });
    } finally {
      try {
        this.convs.compactTextDeltas(subtask.id);
      } catch (error) {
        console.error("Compaction des deltas de sous-tâche impossible", error);
      }
      this.store.setStatus(subtask.id, outcome.terminal ?? "error");
    }
  }

  /**
   * Au démarrage du sidecar, toute subtask encore `running` en base est
   * orpheline (son process est mort avec l'instance précédente) : on la clôt en
   * erreur pour ne pas laisser une carte tourner indéfiniment côté UI.
   */
  private sweepOrphaned(): void {
    for (const subtask of this.store.listRunning()) {
      this.convs.appendEvent(subtask.id, {
        type: "status",
        state: "error",
        error: "interrompu (sidecar redémarré)",
      });
      this.store.setStatus(subtask.id, "error");
    }
  }
}
