import type { ConversationRunner } from "./runner";
import type { ConversationStore } from "./stores/conversations";
import type { ProjectStore } from "./stores/projects";
import type { TicketStore } from "./stores/tickets";
import type { QuotaTracker } from "./quotas";
import { normalizeRemoteUrl, type GitProjectService } from "./git";
import { TodoStore, TODO_FINISHES, type TodoInput, type TodoItem } from "./stores/todos";
import { isProvider } from "./events";
import { PRESET_PERMISSION_MODES } from "./stores/presets";
export class TodoError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export async function todoGit(cwd: string, args: string[]): Promise<string> {
  const p = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code) throw new TodoError(err.trim() || `git ${args[0]} a échoué`, 409);
  return out.trim();
}
const EDITABLE = ["backlog", "queued", "blocked"];
/** Bloc \`\`\`commit … \`\`\` de la réponse finale : sujet puis corps facultatif. */
export function commitMessageOf(text: string, fallback: string): string {
  const match = text.match(/```commit\s*\n([\s\S]*?)```/);
  const message = match?.[1]?.trim();
  if (!message) return fallback;
  const [subject = "", ...rest] = message.split("\n");
  const trimmed = subject.trim().slice(0, 72);
  return trimmed ? [trimmed, ...rest].join("\n").trim() : fallback;
}
/** Liens web d'une branche poussée : arborescence et création de MR / PR. */
export function remoteLinks(remote: string | null, branch: string, target: string): { branchUrl: string | null; mergeRequestUrl: string | null } {
  const base = normalizeRemoteUrl(remote);
  if (!base) return { branchUrl: null, mergeRequestUrl: null };
  const source = encodeURIComponent(branch), into = encodeURIComponent(target);
  if (new URL(base).hostname.includes("github"))
    return { branchUrl: `${base}/tree/${source}`, mergeRequestUrl: `${base}/compare/${into}...${source}?expand=1` };
  return {
    branchUrl: `${base}/-/tree/${source}`,
    mergeRequestUrl: `${base}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${source}&merge_request%5Btarget_branch%5D=${into}`,
  };
}
export class TodoService {
  private enabled = new Set<string>();
  private active: string | null = null;
  constructor(
    public store: TodoStore,
    private projects: ProjectStore,
    private conversations: ConversationStore,
    private runner: Pick<ConversationRunner, "runTurn" | "isRunning">,
    private git: GitProjectService,
    private tickets: TicketStore,
    private quotas: QuotaTracker,
  ) {}
  queue(projectId: string) {
    return {
      running: this.enabled.has(projectId),
      activeTodoId:
        this.active && this.store.get(this.active)?.project_id === projectId
          ? this.active
          : null,
    };
  }
  snapshot(projectId: string) {
    this.project(projectId);
    return { items: this.store.list(projectId), queue: this.queue(projectId) };
  }
  private project(id: string) {
    const p = this.projects.get(id);
    if (!p) throw new TodoError("Projet inconnu", 404);
    return p;
  }
  item(id: string) {
    const t = this.store.get(id);
    if (!t) throw new TodoError("TODO inconnu", 404);
    return t;
  }
  private validate(projectId: string, input: TodoInput) {
    this.project(projectId);
    const allowed = new Set([
      "status",
      "title",
      "message",
      "targetBranch",
      "ticketId",
      "finish",
      "provider",
      "model",
      "effort",
      "speed",
      "presetId",
      "permissionMode",
      "images",
      "attachments",
    ]);
    if (Object.keys(input).some((key) => !allowed.has(key)))
      throw new TodoError("Champ TODO inconnu");
    if (input.status !== undefined && !["backlog", "queued"].includes(input.status))
      throw new TodoError("Statut initial invalide");
    for (const key of ["targetBranch", "ticketId", "effort", "presetId"] as const) {
      if (input[key] != null && typeof input[key] !== "string")
        throw new TodoError(`${key} invalide`);
    }
    if (input.speed != null && !["standard", "fast"].includes(input.speed))
      throw new TodoError("Vitesse invalide");
    if (
      input.permissionMode != null &&
      !PRESET_PERMISSION_MODES.includes(input.permissionMode)
    )
      throw new TodoError("Permissions invalides");
    if (
      typeof input.message !== "string" ||
      !input.message.trim() ||
      !isProvider(input.provider) ||
      typeof input.model !== "string" ||
      !input.model.trim()
    )
      throw new TodoError("Message, provider et modèle requis");
    if (input.title !== undefined && typeof input.title !== "string")
      throw new TodoError("Titre invalide");
    if (input.finish !== undefined && !TODO_FINISHES.includes(input.finish))
      throw new TodoError("Fin de tâche invalide");
    if (
      input.images !== undefined &&
      (!Array.isArray(input.images) ||
        input.images.some((x) => typeof x !== "string" || !x.trim()))
    )
      throw new TodoError("images invalide");
    if (
      input.attachments !== undefined &&
      (!Array.isArray(input.attachments) ||
        input.attachments.some(
          (x) =>
            !x ||
            typeof x.name !== "string" ||
            typeof x.originalName !== "string" ||
            typeof x.mimeType !== "string" ||
            typeof x.size !== "number",
        ))
    )
      throw new TodoError("Pièces jointes invalides");
    if (
      input.ticketId &&
      this.tickets.get(input.ticketId)?.project_id !== projectId
    )
      throw new TodoError("Ticket hors projet");
  }
  async create(projectId: string, input: TodoInput) {
    this.validate(projectId, input);
    const branch = input.status === "backlog"
      ? input.targetBranch?.trim() || ""
      : await this.targetBranch(projectId, input.targetBranch);
    this.validate(projectId, input);
    return this.store.create(projectId, { ...input, targetBranch: branch });
  }
  private async targetBranch(projectId: string, target?: string | null) {
    const cwd = this.project(projectId).path;
    const branch =
      target?.trim() ||
      (await todoGit(cwd, ["symbolic-ref", "--short", "HEAD"]));
    await todoGit(cwd, ["check-ref-format", "--branch", branch]);
    await todoGit(cwd, ["rev-parse", "--verify", `refs/heads/${branch}`]);
    return branch;
  }
  private unstarted(item: TodoItem) {
    return this.active !== item.id && !item.conversation_id && !item.branch &&
      !item.worktree_path && !item.execution_completed;
  }
  private running(item: TodoItem) {
    return item.status === "running" || this.active === item.id;
  }
  async edit(id: string, patch: Partial<TodoInput>) {
    const item = this.item(id);
    if (Object.hasOwn(patch, "status"))
      throw new TodoError("Utiliser une action pour changer le statut");
    if (!EDITABLE.includes(item.status) || !this.unstarted(item))
      throw new TodoError("Seuls les TODO en attente sont modifiables", 409);
    const input: TodoInput = {
      status: item.status === "queued" ? "queued" : "backlog",
      title: item.title,
      message: item.message,
      targetBranch: item.target_branch,
      ticketId: item.ticket_id,
      finish: item.finish,
      provider: item.provider,
      model: item.model,
      effort: item.effort,
      speed: item.speed,
      presetId: item.preset_id,
      permissionMode: item.permission_mode,
      images: item.images,
      attachments: item.attachments,
      ...patch,
    };
    this.validate(item.project_id, input);
    if (input.status === "queued")
      input.targetBranch = await this.targetBranch(item.project_id, input.targetBranch);
    else input.targetBranch = input.targetBranch?.trim() || "";
    if (JSON.stringify(this.item(id)) !== JSON.stringify(item))
      throw new TodoError("La TODO a changé ou a démarré pendant l’enregistrement", 409);
    this.validate(item.project_id, input);
    const mapping: Record<string, string> = {
      targetBranch: "target_branch",
      ticketId: "ticket_id",
      presetId: "preset_id",
      permissionMode: "permission_mode",
    };
    return this.store.update(
      id,
      { ...Object.fromEntries(
        Object.entries(input).map(([k, v]) => [mapping[k] ?? k, v]),
      ), error: null },
    );
  }
  remove(id: string) {
    const t = this.item(id);
    if (this.running(t))
      throw new TodoError("Une tâche en cours ne peut pas être supprimée", 409);
    this.store.delete(id);
  }
  complete(id: string) {
    const item = this.item(id);
    if (this.running(item))
      throw new TodoError("Une tâche en cours ne peut pas être terminée", 409);
    return this.store.update(id, { status: "done", error: null });
  }
  reopen(id: string) {
    const item = this.item(id);
    if (item.status !== "done")
      throw new TodoError("Seule une tâche terminée peut être rouverte", 409);
    return this.store.update(id, {
      status: this.unstarted(item) ? "backlog" : "awaiting_validation",
      error: null,
    });
  }
  /** Rattache une conversation ouverte à la main depuis la tâche : la tâche
   *  quitte la pile exécutable et se clôt par la coche. */
  link(id: string, conversationId: string) {
    const item = this.item(id);
    const conversation = this.conversations.get(conversationId);
    if (!conversation || conversation.project_id !== item.project_id)
      throw new TodoError("Conversation hors projet", 404);
    if (!this.unstarted(item) || !EDITABLE.includes(item.status))
      throw new TodoError("Cette tâche a déjà une exécution", 409);
    return this.store.update(id, {
      conversation_id: conversationId,
      status: "awaiting_validation",
      error: null,
    });
  }
  async enqueue(id: string) {
    const item = this.item(id);
    if (!["backlog", "blocked"].includes(item.status) || !this.unstarted(item))
      throw new TodoError("Cette tâche ne peut pas être mise en file", 409);
    const branch = await this.targetBranch(item.project_id, item.target_branch);
    if (JSON.stringify(this.item(id)) !== JSON.stringify(item))
      throw new TodoError("La tâche a changé pendant la mise en file", 409);
    this.store.update(id, { status: "queued", target_branch: branch, error: null });
    this.pump();
    return { item: this.item(id) };
  }
  /** Dépile : chaque tâche à faire passe en file dans l'ordre de la liste,
   *  puis la file démarre. Une branche introuvable bloque la tâche sans
   *  arrêter les autres. */
  async drain(projectId: string) {
    this.project(projectId);
    for (const item of this.store.list(projectId)) {
      if (item.status !== "backlog" || !this.unstarted(item)) continue;
      try {
        const branch = await this.targetBranch(projectId, item.target_branch);
        const current = this.store.get(item.id);
        if (!current || current.status !== "backlog") continue;
        this.store.update(item.id, { status: "queued", target_branch: branch, error: null });
      } catch (error) {
        this.store.update(item.id, {
          status: "blocked",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.enabled.add(projectId);
    this.pump();
    return this.snapshot(projectId);
  }
  setQueue(projectId: string, running: boolean) {
    this.project(projectId);
    if (running) this.enabled.add(projectId);
    else this.enabled.delete(projectId);
    this.pump();
    return this.queue(projectId);
  }
  reorder(projectId: string, ids: string[]) {
    this.project(projectId);
    try {
      this.store.reorder(projectId, ids);
    } catch (error) {
      throw new TodoError(
        error instanceof Error ? error.message : "Ordre invalide",
      );
    }
    return this.snapshot(projectId);
  }
  start(id: string) {
    const item = this.item(id);
    if (this.active) throw new TodoError("Une tâche est déjà en cours", 409);
    if (!["backlog", "queued", "blocked"].includes(item.status) || !this.unstarted(item))
      throw new TodoError("Ce TODO a déjà été lancé", 409);
    this.launch(item);
    return { item: this.item(id) };
  }
  private pump() {
    if (this.active) return;
    for (const t of this.store.list()) {
      if (!this.enabled.has(t.project_id) || t.status !== "queued" || !this.unstarted(t)) continue;
      this.launch(t);
      return;
    }
  }
  private launch(t: TodoItem) {
    this.active = t.id;
    this.store.update(t.id, { status: "running", error: null });
    void this.execute(t)
      .catch((e) => {
        const message = e instanceof Error ? e.message : String(e);
        this.store.update(t.id, { status: "blocked", error: message });
        if (/quota|rate.?limit|\b429\b|usage limit|capacity|crédit/i.test(message))
          this.enabled.clear();
      })
      .finally(() => {
        this.active = null;
        this.pump();
      });
  }
  private context(t: TodoItem) {
    const ticket = t.ticket_id ? this.tickets.get(t.ticket_id) : null;
    const related = this.store
      .list(t.project_id)
      .filter((x) => x.id !== t.id && x.ticket_id === t.ticket_id)
      .slice(-12)
      .map((x) => ({ id: x.id, title: x.title, status: x.status }));
    const digests = this.conversations
      .listByProject(t.project_id)
      .concat(this.conversations.listByProject(t.project_id, "archived"))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .filter((x) => x.ticket_id === t.ticket_id)
      .slice(0, 8)
      .map((x) => ({
        id: x.id,
        title: x.title,
        summary: x.summary.slice(0, 1200),
        updatedAt: x.updated_at,
      }));
    const commitBlock = "Termine ta réponse par un bloc ```commit contenant le message de commit : un sujet à l'impératif de 72 caractères au plus, une ligne vide, puis un corps facultatif expliquant le pourquoi.";
    const finish = t.finish === "none"
      ? "Laisse les modifications dans le worktree, sans commit : l'utilisateur les relira."
      : t.finish === "commit"
        ? `Ne committe pas toi-même : la file committera le résultat sur cette branche. ${commitBlock}`
        : `Ne committe pas et ne pousse pas toi-même : la file committera puis poussera cette branche. ${commitBlock}`;
    return `TODO ${t.id}. Périmètre strict : projet ${t.project_id}, ticket ${t.ticket_id ?? "aucun"}. Ne pas élargir implicitement le périmètre.\nTravaille exclusivement dans le worktree fourni, sur sa branche dédiée ; ne fusionne aucune branche. ${finish}\nTermine avec le diff, les vérifications exécutées et leurs résultats, et une URL de prévisualisation réellement accessible si possible.\nContexte borné (identifiants pour approfondir) : ${JSON.stringify({ ticket: ticket ? { id: ticket.id, title: ticket.title, instruction: ticket.instruction.slice(0, 6000) } : null, related, digests })}`;
  }
  private async execute(initial: TodoItem) {
    let t = initial;
    if (
      this.quotas
        .get(t.provider)
        ?.windows.some((w) => w.usedPercent !== null && w.usedPercent >= 85)
    )
      throw new TodoError(
        "Quota : réserve de 15 % pour votre activité atteinte",
        409,
      );
    const target = await this.targetBranch(t.project_id, t.target_branch);
    t = this.store.update(t.id, { target_branch: target });
    const branch = `codex/todo-${t.id}-${crypto.randomUUID().slice(0, 8)}`;
    const worktree = this.git.createWorktree(t.project_id, {
      branch,
      startPoint: `refs/heads/${t.target_branch}`,
    });
    t = this.store.update(t.id, { branch, worktree_path: worktree.path });
    const conversation = this.conversations.create({
      projectId: t.project_id,
      provider: t.provider,
      model: t.model,
      effort: t.effort,
      speed: t.speed,
      presetId: t.preset_id,
      permissionMode: t.permission_mode,
      worktreePath: worktree.path,
      createdOnBranch: branch,
      ticketId: t.ticket_id,
      firstMessage: t.message,
    });
    t = this.store.update(t.id, { conversation_id: conversation.id });
    const outcome = await this.runner.runTurn(
      conversation.id,
      t.message,
      t.images,
      t.attachments,
      { preamble: this.context(t) },
    );
    if (outcome.state !== "done" || outcome.cancelled)
      throw new TodoError(outcome.error || "Tour interrompu ou en échec", 409);
    t = this.store.update(t.id, { execution_completed: true });
    const final = this.conversations.listEvents(conversation.id).filter((e) => e.type === "text-final").at(-1);
    await this.finish(t, commitMessageOf(final?.text ?? "", t.title));
    this.store.update(t.id, { status: "awaiting_validation", error: null });
  }
  private async finish(t: TodoItem, message: string) {
    if (t.finish === "none") return;
    const worktree = t.worktree_path!;
    if (this.runner.isRunning(t.conversation_id!))
      throw new TodoError("La conversation est encore active", 409);
    if ((await todoGit(worktree, ["symbolic-ref", "--short", "HEAD"])) !== t.branch)
      throw new TodoError("La branche du worktree a changé", 409);
    if (await todoGit(worktree, ["status", "--porcelain"])) {
      await todoGit(worktree, ["add", "-A"]);
      await todoGit(worktree, ["commit", "-m", message]);
      this.store.update(t.id, {
        commit_sha: await todoGit(worktree, ["rev-parse", "HEAD"]),
        commit_message: message,
      });
    }
    if (t.finish === "commit_push") {
      await todoGit(worktree, ["push", "-u", "origin", t.branch!]);
      const remote = await todoGit(worktree, ["remote", "get-url", "origin"]).catch(() => null);
      const links = remoteLinks(remote, t.branch!, t.target_branch);
      this.store.update(t.id, { branch_url: links.branchUrl, merge_request_url: links.mergeRequestUrl });
    }
  }
}
