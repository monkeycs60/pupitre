import type { ConversationRunner } from "./runner";
import type { ConversationStore } from "./stores/conversations";
import type { ProjectStore } from "./stores/projects";
import type { TicketStore } from "./stores/tickets";
import type { QuotaTracker } from "./quotas";
import type { GitProjectService } from "./git";
import { TodoStore, type TodoInput, type TodoItem } from "./stores/todos";
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
  private validate(projectId: string, input: TodoInput, id?: string) {
    this.project(projectId);
    const allowed = new Set([
      "status",
      "title",
      "message",
      "targetBranch",
      "ticketId",
      "integrate",
      "autonomy",
      "dependsOn",
      "provider",
      "model",
      "effort",
      "speed",
      "presetId",
      "permissionMode",
      "orchestrator",
      "subagentPresetId",
      "subagentEffort",
      "images",
      "attachments",
      "checks",
    ]);
    if (Object.keys(input).some((key) => !allowed.has(key)))
      throw new TodoError("Champ TODO inconnu");
    if (input.status !== undefined && !["backlog", "queued"].includes(input.status))
      throw new TodoError("Statut initial invalide");
    for (const key of [
      "targetBranch",
      "ticketId",
      "dependsOn",
      "effort",
      "presetId",
      "subagentPresetId",
      "subagentEffort",
    ] as const) {
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
    if (
      input.autonomy !== undefined &&
      !["local", "investigate"].includes(input.autonomy)
    )
      throw new TodoError("Autonomie invalide");
    if (id && this.store.list(projectId).some((other) => other.depends_on === id && other.ticket_id !== (input.ticketId ?? null)))
      throw new TodoError("Les TODO dépendantes doivent rester dans le même ticket", 409);
    for (const key of ["integrate", "orchestrator"] as const)
      if (input[key] !== undefined && typeof input[key] !== "boolean")
        throw new TodoError(`${key} invalide`);
    for (const key of ["checks", "images"] as const)
      if (
        input[key] !== undefined &&
        (!Array.isArray(input[key]) ||
          input[key]!.some((x) => typeof x !== "string" || !x.trim()))
      )
        throw new TodoError(`${key} invalide`);
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
    if (input.dependsOn) {
      let dep: TodoItem | null = this.item(input.dependsOn);
      if (
        dep.project_id !== projectId ||
        dep.ticket_id !== (input.ticketId ?? null)
      )
        throw new TodoError("Dépendance hors projet/ticket");
      const seen = new Set([id]);
      while (dep) {
        if (seen.has(dep.id)) throw new TodoError("Dépendance cyclique");
        seen.add(dep.id);
        dep = dep.depends_on ? this.item(dep.depends_on) : null;
      }
    }
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
      !item.worktree_path && !item.execution_completed && !item.publication_pending;
  }
  private integrated(item: TodoItem) {
    return item.status === "done" && item.execution_completed &&
      !!item.conversation_id && !!item.branch && !!item.worktree_path &&
      !item.publication_pending;
  }
  async edit(id: string, patch: Partial<TodoInput>) {
    const item = this.item(id);
    if (Object.hasOwn(patch, "status"))
      throw new TodoError("Utiliser une action pour changer le statut");
    if (!["backlog", "queued", "blocked"].includes(item.status) || !this.unstarted(item)) {
      if (
        ["awaiting_validation", "blocked"].includes(item.status) &&
        Object.keys(patch).every((k) => k === "checks") &&
        Array.isArray(patch.checks) &&
        patch.checks.every((c) => typeof c === "string" && c.trim())
      )
        return this.store.update(id, { checks: patch.checks });
      throw new TodoError("Seuls les TODO en attente sont modifiables", 409);
    }
    const input: TodoInput = {
      status: item.status === "queued" ? "queued" : "backlog",
      title: item.title,
      message: item.message,
      targetBranch: item.target_branch,
      ticketId: item.ticket_id,
      integrate: item.integrate,
      autonomy: item.autonomy,
      dependsOn: item.depends_on,
      provider: item.provider,
      model: item.model,
      effort: item.effort,
      speed: item.speed,
      presetId: item.preset_id,
      permissionMode: item.permission_mode,
      orchestrator: item.orchestrator,
      subagentPresetId: item.subagent_preset_id,
      subagentEffort: item.subagent_effort,
      images: item.images,
      attachments: item.attachments,
      checks: item.checks,
      ...patch,
    };
    this.validate(item.project_id, input, id);
    if (input.status === "queued")
      input.targetBranch = await this.targetBranch(item.project_id, input.targetBranch);
    else input.targetBranch = input.targetBranch?.trim() || "";
    if (JSON.stringify(this.item(id)) !== JSON.stringify(item))
      throw new TodoError("La TODO a changé ou a démarré pendant l’enregistrement", 409);
    this.validate(item.project_id, input, id);
    const mapping: Record<string, string> = {
      targetBranch: "target_branch",
      ticketId: "ticket_id",
      dependsOn: "depends_on",
      presetId: "preset_id",
      permissionMode: "permission_mode",
      subagentPresetId: "subagent_preset_id",
      subagentEffort: "subagent_effort",
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
    if (
      !["backlog", "queued", "blocked"].includes(t.status) ||
      !this.unstarted(t) ||
      this.store.list().some((x) => x.depends_on === id)
    )
      throw new TodoError("TODO lancé ou utilisé par une dépendance", 409);
    this.store.delete(id);
  }
  complete(id: string) {
    const item = this.item(id);
    if (!["backlog", "queued", "blocked"].includes(item.status) || !this.unstarted(item))
      throw new TodoError("Seule une tâche sans exécution peut être terminée manuellement", 409);
    return this.store.update(id, { status: "done", error: null });
  }
  reopen(id: string) {
    const item = this.item(id);
    if (item.status !== "done" || !this.unstarted(item))
      throw new TodoError("Seule une tâche terminée manuellement peut être rouverte", 409);
    return this.store.update(id, { status: "backlog", error: null });
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
    if (!["backlog", "queued"].includes(item.status) || !this.unstarted(item))
      throw new TodoError("Ce TODO a déjà été lancé", 409);
    if (item.depends_on && !this.integrated(this.item(item.depends_on)))
      throw new TodoError("La dépendance doit être intégrée", 409);
    if (this.publicationBarrier(item)) throw new TodoError("Une intégration de cette branche attend sa réconciliation", 409);
    this.launch(item, false);
    return { item: this.item(id) };
  }
  reconcile(id: string) {
    const t = this.item(id);
    if (this.active) throw new TodoError("Une tâche est déjà en cours", 409);
    if (
      !t.execution_completed ||
      !t.conversation_id ||
      !t.worktree_path ||
      !["awaiting_validation", "blocked"].includes(t.status)
    )
      throw new TodoError("Aucun résultat à réconcilier", 409);
    if (this.runner.isRunning(t.conversation_id))
      throw new TodoError("La conversation est encore active", 409);
    this.launch(t, true);
    return { item: this.item(id) };
  }
  private publicationBarrier(item: TodoItem): boolean {
    return this.store.list().some((other) => other.id !== item.id
      && other.project_id === item.project_id && other.target_branch === item.target_branch
      && other.publication_pending && other.status !== "done");
  }
  private pump() {
    if (this.active) return;
    for (let t of this.store.list()) {
      if (
        t.status === "blocked" &&
        this.unstarted(t) &&
        t.depends_on &&
        t.error === `Dépendance bloquée : ${t.depends_on}` &&
        this.integrated(this.item(t.depends_on))
      ) {
        t = this.store.update(t.id, { status: "queued", error: null });
      }
      if (!this.enabled.has(t.project_id) || t.status !== "queued" || !this.unstarted(t)) continue;
      if (this.publicationBarrier(t)) continue;
      const dep = t.depends_on ? this.item(t.depends_on) : null;
      if (dep?.status === "blocked") {
        this.store.update(t.id, {
          status: "blocked",
          error: `Dépendance bloquée : ${dep.id}`,
        });
        continue;
      }
      if (dep && !this.integrated(dep)) continue;
      this.launch(t, false);
      return;
    }
  }
  private launch(t: TodoItem, reconcile: boolean) {
    this.active = t.id;
    this.store.update(t.id, { status: "running", error: null });
    void this.execute(t, reconcile)
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
    return `TODO ${t.id}. Périmètre strict : projet ${t.project_id}, ticket ${t.ticket_id ?? "aucun"}. Ne pas élargir implicitement le périmètre.\nAutonomie : ${t.autonomy === "investigate" ? "investigation seulement, aucune modification de code" : "corrections locales autorisées"}.\nNe fusionne et ne pousse aucune branche. Travaille exclusivement dans le worktree fourni. Si le travail est terminé sans besoin de clarification ou autorisation préalable, ajoute exactement [TODO_READY] dans ta réponse finale. Ne mets pas ce marqueur si tu attends une réponse pour continuer le travail. Termine avec le diff, les vérifications exécutées et leurs résultats, et une URL de prévisualisation réellement accessible si possible. ${t.integrate ? "L'intégration sera effectuée séparément par la file après contrôles." : "Demande la validation de l'utilisateur avant intégration."}\nContexte borné (identifiants pour approfondir) : ${JSON.stringify({ ticket: ticket ? { id: ticket.id, title: ticket.title, instruction: ticket.instruction.slice(0, 6000) } : null, related, digests })}`;
  }
  private async execute(initial: TodoItem, reconcile: boolean) {
    let t = initial;
    const cwd = this.project(t.project_id).path;
    if (!reconcile) {
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
      if (this.publicationBarrier(t))
        throw new TodoError("Une intégration de cette branche attend sa réconciliation", 409);
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
        orchestrator: t.orchestrator,
        subagentPresetId: t.subagent_preset_id,
        subagentEffort: t.subagent_effort,
        worktreePath: worktree.path,
        createdOnBranch: branch,
        ticketId: t.ticket_id,
        firstMessage: t.message,
      });
      t = this.store.update(t.id, {
        conversation_id: conversation.id,
      });
      const outcome = await this.runner.runTurn(
        conversation.id,
        t.message,
        t.images,
        t.attachments,
        { preamble: this.context(t) },
      );
      if (outcome.state !== "done" || outcome.cancelled)
        throw new TodoError(
          outcome.error || "Tour interrompu ou en échec",
          409,
        );
      const events = this.conversations.listEvents(conversation.id);
      const final = events.filter((e) => e.type === "text-final").at(-1);
      if (!final) throw new TodoError("Aucune réponse finale à valider", 409);
      t = this.store.update(t.id, { execution_completed: true });
      if (
        !t.integrate ||
        t.autonomy === "investigate" ||
        !final.text.includes("[TODO_READY]")
      ) {
        this.store.update(t.id, { status: "awaiting_validation" });
        return;
      }
    }
    await this.integrate(t, cwd);
    this.store.update(t.id, { status: "done", error: null, publication_pending: false });
  }
  private async checks(t: TodoItem, cwd: string) {
    if (!t.checks.length)
      throw new TodoError(
        "Renseigner les commandes de vérification avant intégration",
        409,
      );
    for (const command of t.checks) {
      const p = Bun.spawn(["sh", "-c", command], {
        cwd,
        stdout: "ignore",
        stderr: "pipe",
      });
      const timeout = setTimeout(() => p.kill(), 300_000);
      try {
        const [error, code] = await Promise.all([
          new Response(p.stderr).text(),
          p.exited,
        ]);
        if (code)
          throw new TodoError(
            `Vérification échouée : ${command}\n${error.slice(-3000)}`,
            409,
          );
      } finally {
        clearTimeout(timeout);
      }
    }
  }
  private async integrate(t: TodoItem, cwd: string) {
    const worktree = t.worktree_path!;
    if (this.runner.isRunning(t.conversation_id!))
      throw new TodoError("La conversation est encore active", 409);
    if (
      (await todoGit(worktree, ["symbolic-ref", "--short", "HEAD"])) !==
      t.branch
    )
      throw new TodoError("La branche du worktree a changé", 409);
    if (t.autonomy === "investigate")
      throw new TodoError("Une investigation ne peut pas être intégrée", 409);
    await this.checks(t, worktree);
    if (await todoGit(worktree, ["status", "--porcelain"])) {
      await todoGit(worktree, ["add", "-A"]);
      await todoGit(worktree, ["commit", "-m", t.title]);
    }
    await todoGit(cwd, ["fetch", "origin", t.target_branch]);
    const target = await todoGit(cwd, [
      "rev-parse",
      `refs/heads/${t.target_branch}`,
    ]);
    const remote = await todoGit(cwd, ["rev-parse", "FETCH_HEAD"]);
    const verify = this.git.createDetachedWorktree(t.project_id, {
      name: `todo-verify-${t.id}-${crypto.randomUUID().slice(0, 8)}`,
      startPoint: target,
    });
    await todoGit(verify.path, ["merge", "--no-edit", remote]);
    await todoGit(verify.path, ["merge", "--no-edit", t.branch!]);
    await this.checks(t, verify.path);
    if (await todoGit(verify.path, ["status", "--porcelain"]))
      throw new TodoError(
        "Les vérifications ont modifié le résultat fusionné",
        409,
      );
    const merged = await todoGit(verify.path, ["rev-parse", "HEAD"]);
    const worktrees = await todoGit(cwd, ["worktree", "list", "--porcelain"]);
    const targetBlock = worktrees
      .split("\n\n")
      .find((b) =>
        b.split("\n").includes(`branch refs/heads/${t.target_branch}`),
      );
    const targetPath = targetBlock
      ?.split("\n")
      .find((l) => l.startsWith("worktree "))
      ?.slice(9);
    if (
      (await todoGit(cwd, ["rev-parse", `refs/heads/${t.target_branch}`])) !==
      target
    )
      throw new TodoError(
        "La branche cible a avancé pendant les vérifications",
        409,
      );
    if (targetPath && await todoGit(targetPath, ["status", "--porcelain"]))
      throw new TodoError("Le worktree cible contient des modifications locales", 409);
    this.store.update(t.id, { publication_pending: true });
    await todoGit(cwd, [
      "push",
      "origin",
      `${merged}:refs/heads/${t.target_branch}`,
    ]);
    if (targetPath) {
      if (await todoGit(targetPath, ["status", "--porcelain"]))
        throw new TodoError(
          "Le worktree cible contient des modifications locales",
          409,
        );
      await todoGit(targetPath, ["merge", "--ff-only", merged]);
    } else
      await todoGit(cwd, [
        "update-ref",
        `refs/heads/${t.target_branch}`,
        merged,
        target,
      ]);

  }
}
