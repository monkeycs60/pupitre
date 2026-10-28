import { homedir } from "node:os";
import { generateWithAdapters, prewarmWithAdapters } from "./debriefs";
import {
  draftJson,
  escalationReason,
  finalizeAnswer,
  jarvisPrompt,
  parseModelJson,
  parseRouterVerdict,
  routerPrompt,
  sanitizeDraft,
  type JarvisAnswer,
  type JarvisDraft,
  type RouterVerdict,
  earlyEscalation,
} from "./jarvis-answer";
import {
  clipText,
  JarvisContextBuilder,
  type JarvisContext,
  type JarvisContextDeps,
  type JarvisHistoryEntry,
  type JarvisLiveState,
  liveTotals,
} from "./jarvis-context";
import type { QuotaTracker } from "./quotas";
import { listRunningApplications, type ApplicationContext, type RunningApplication } from "./running-applications";
import { SemanticSearchUnavailable, type SemanticSearch, type SemanticSearchHit } from "./semantic-search";
import { projectCwd } from "./workspace";

export type { JarvisAction, JarvisAnswer, JarvisResult } from "./jarvis-answer";

export type JarvisMode = "auto" | "fast" | "orchestrate";
export type JarvisModel = "haiku-5.5" | "opus-5.5";
export type JarvisEffort = "low" | "high";

export interface JarvisAskInput {
  question: string;
  projectId: string | null;
  conversationId: string | null;
  history: JarvisHistoryEntry[];
  mode: JarvisMode;
}

export interface JarvisStep {
  id: string;
  label: string;
  detail: string | null;
  state: "running" | "done" | "skipped" | "error";
  at: string;
}

export interface JarvisRoute {
  model: JarvisModel;
  effort: "high";
  label: string;
  reason: string;
  escalated: boolean;
  /** Qui a choisi le modèle : le mode imposé, Haiku 5.5 en lisant les données, ou le routeur express. */
  by: "mode" | "haiku" | "router";
}

export interface JarvisJob {
  id: string;
  status: "running" | "done" | "error" | "cancelled";
  steps: JarvisStep[];
  route: JarvisRoute | null;
  answer: JarvisAnswer | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface JarvisGenerationInput {
  model: JarvisModel;
  effort?: JarvisEffort;
  prompt: string;
  cwd: string;
  signal: AbortSignal;
  onText?: (text: string) => void;
}

export type JarvisGenerator = (input: JarvisGenerationInput) => Promise<string>;

export interface JarvisDeps extends Omit<JarvisContextDeps, "runningApplications"> {
  generate: JarvisGenerator;
  /** Lance d'avance le process d'un modèle qui répondra en premier. */
  prewarm?: (input: { model: JarvisModel; effort: JarvisEffort; cwd: string }) => void;
  semanticSearch?: Pick<SemanticSearch, "search">;
  runningApplications?: (contexts: ApplicationContext[]) => RunningApplication[];
  now?: () => number;
  semanticTimeoutMs?: number;
}

export class JarvisInputError extends Error {}

/** Haiku a annoncé en tête de réponse qu'il fallait un plan : on l'arrête pour lancer Opus aussitôt. */
class JarvisHandoff extends Error {}

export const MAX_QUESTION_CHARS = 2_000;
const MAX_HISTORY_ENTRIES = 6;
const MAX_HISTORY_CHARS = 4_000;
const JOB_TTL_MS = 30 * 60_000;
const MAX_JOBS = 50;
const SEMANTIC_TIMEOUT_MS = 4_000;
const ROUTER_TIMEOUT_MS = 20_000;

const MODELS: Record<JarvisModel, { name: string; label: string; timeoutMs: number }> = {
  "haiku-5.5": { name: "Haiku 5.5", label: "Haiku 5.5 · rapide", timeoutMs: 90_000 },
  "opus-5.5": { name: "Opus 5.5", label: "Opus 5.5 · orchestration", timeoutMs: 240_000 },
};

/**
 * `mcpServers: {}` devient `--strict-mcp-config` sur une liste vide : aucun
 * serveur MCP, pas même ceux de l'utilisateur, que le CLI chargerait tous si
 * le champ manquait.
 */
export function claudeJarvisGenerator(quotas: QuotaTracker): JarvisGenerator {
  return ({ model, effort = "high", prompt, cwd, signal, onText }) => generateWithAdapters({
    cwd,
    provider: "claude",
    model,
    effort,
    prompt,
    signal,
    mcpServers: {},
    oneShot: true,
    onText,
  }, quotas);
}

export function claudeJarvisPrewarm(): NonNullable<JarvisDeps["prewarm"]> {
  return ({ model, effort, cwd }) => prewarmWithAdapters({ cwd, provider: "claude", model, effort, mcpServers: {}, oneShot: true });
}

function route(model: JarvisModel, reason: string, by: JarvisRoute["by"], escalated = false): JarvisRoute {
  return { model, effort: "high", label: MODELS[model].label, reason, escalated, by };
}

function optionalId(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new JarvisInputError(`champ ${field} invalide`);
  return value.trim() || null;
}

export function parseAskInput(body: unknown): JarvisAskInput {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new JarvisInputError("corps JSON invalide");
  const record = body as Record<string, unknown>;
  const question = typeof record.question === "string" ? record.question.trim() : "";
  if (!question) throw new JarvisInputError("question vide");
  if (question.length > MAX_QUESTION_CHARS) {
    throw new JarvisInputError(`question trop longue (${MAX_QUESTION_CHARS} caractères au plus)`);
  }
  const mode = record.mode ?? "auto";
  if (mode !== "auto" && mode !== "fast" && mode !== "orchestrate") throw new JarvisInputError("mode invalide");
  const rawHistory = record.history ?? [];
  if (!Array.isArray(rawHistory)) throw new JarvisInputError("historique invalide");
  const history = rawHistory.map((entry): JarvisHistoryEntry => {
    const item = (entry ?? {}) as Record<string, unknown>;
    if ((item.role !== "user" && item.role !== "jarvis") || typeof item.text !== "string") {
      throw new JarvisInputError("entrée d'historique invalide");
    }
    return { role: item.role, text: item.text.slice(0, MAX_HISTORY_CHARS) };
  }).filter((entry) => entry.text.trim() !== "").slice(-MAX_HISTORY_ENTRIES);
  return {
    question,
    projectId: optionalId(record, "projectId"),
    conversationId: optionalId(record, "conversationId"),
    history,
    mode,
  };
}

function count(value: number, singular: string, plural: string, none: string): string {
  if (value === 0) return none;
  return `${value} ${value > 1 ? plural : singular}`;
}

function liveDetail(live: JarvisLiveState): string {
  const { running, waiting, unread } = liveTotals(live);
  return [
    running === 0 ? "aucun agent en cours" : `${running} en cours`,
    waiting === 0 ? "personne ne t'attend" : waiting === 1 ? "1 t'attend" : `${waiting} t'attendent`,
    unread > 0 ? count(unread, "non lue", "non lues", "") : null,
  ].filter(Boolean).join(", ");
}

function seconds(milliseconds: number): string {
  return `${(milliseconds / 1_000).toFixed(1).replace(".", ",")} s`;
}

function verifyDetail(draft: JarvisDraft): string {
  const detail = [
    count(draft.results.length, "résultat", "résultats", "aucun résultat"),
    count(draft.actions.length, "action", "actions", "aucune action"),
  ].join(", ");
  if (draft.dropped.length === 0) return detail;
  const listed = draft.dropped.slice(0, 2).join(" ; ");
  return `${detail} · écarté : ${listed}${draft.dropped.length > 2 ? "…" : ""}`;
}

function messageOf(error: unknown): string {
  return clipText(error instanceof Error ? error.message : String(error), 300) || "erreur inconnue";
}

class JarvisStopped extends Error {}
class JarvisModelError extends Error {}

interface JobRecord {
  job: JarvisJob;
  controller: AbortController;
  startedMs: number;
}

interface StepHandle {
  done(detail?: string | null): void;
  skip(detail: string): void;
  fail(detail: string): void;
}

interface RouterOutcome {
  verdict: RouterVerdict | null;
  ms: number;
}

interface RouterRun {
  settled: Promise<RouterOutcome>;
  outcome: RouterOutcome | null;
  stop: AbortController;
}

export class JarvisService {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly now: () => number;

  constructor(private readonly deps: JarvisDeps) {
    this.now = deps.now ?? Date.now;
  }

  ask(input: JarvisAskInput): JarvisJob {
    this.prune();
    while (this.jobs.size >= MAX_JOBS) {
      const oldest = this.jobs.values().next().value!;
      this.drop(oldest);
    }
    const startedMs = this.now();
    const job: JarvisJob = {
      id: crypto.randomUUID(),
      status: "running",
      steps: [],
      route: null,
      answer: null,
      error: null,
      startedAt: new Date(startedMs).toISOString(),
      finishedAt: null,
    };
    const record = { job, controller: new AbortController(), startedMs };
    this.jobs.set(job.id, record);
    setTimeout(() => void this.run(record, input), 0);
    return job;
  }

  get(id: string): JarvisJob | null {
    this.prune();
    return this.jobs.get(id)?.job ?? null;
  }

  /** Vrai si le job existe ; un job déjà terminé reste tel quel. */
  cancel(id: string): boolean {
    const record = this.jobs.get(id);
    if (!record) return false;
    this.abort(record);
    return true;
  }

  stop(): void {
    for (const record of this.jobs.values()) this.abort(record);
  }

  /** Préchauffe ce que le mode choisi appellera en premier : le modèle qui répond, dans le dossier du projet ouvert, et le routeur en mode auto. */
  warm(projectId: string | null, mode: JarvisAskInput["mode"]): void {
    if (!this.deps.prewarm) return;
    const project = projectId ? this.deps.projects.get(projectId) : null;
    this.deps.prewarm({ model: mode === "orchestrate" ? "opus-5.5" : "haiku-5.5", effort: "high", cwd: project ? projectCwd(project) : homedir() });
    if (mode === "auto") this.deps.prewarm({ model: "haiku-5.5", effort: "low", cwd: homedir() });
  }

  async handle(request: Request, pathname: string): Promise<Response | null> {
    if (pathname === "/api/jarvis/warm") {
      if (request.method !== "POST") return null;
      const body = await request.json().catch(() => null) as { projectId?: unknown; mode?: unknown } | null;
      const mode = body?.mode === "fast" || body?.mode === "orchestrate" ? body.mode : "auto";
      this.warm(typeof body?.projectId === "string" ? body.projectId : null, mode);
      return new Response(null, { status: 204 });
    }
    if (pathname === "/api/jarvis/ask") {
      if (request.method !== "POST") return null;
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "corps JSON invalide" }, { status: 400 });
      }
      try {
        return Response.json({ jobId: this.ask(parseAskInput(body)).id }, { status: 202 });
      } catch (error) {
        if (error instanceof JarvisInputError) return Response.json({ error: error.message }, { status: 400 });
        throw error;
      }
    }
    const match = pathname.match(/^\/api\/jarvis\/jobs\/([^/]+)(\/cancel)?$/);
    if (!match) return null;
    let id: string;
    try {
      id = decodeURIComponent(match[1]!);
    } catch {
      return Response.json({ error: "identifiant invalide" }, { status: 400 });
    }
    if (match[2]) {
      if (request.method !== "POST") return null;
      return this.cancel(id) ? new Response(null, { status: 204 }) : Response.json({ error: "job Jarvis inconnu" }, { status: 404 });
    }
    if (request.method !== "GET") return null;
    const job = this.get(id);
    return job ? Response.json(job) : Response.json({ error: "job Jarvis inconnu" }, { status: 404 });
  }

  private prune(): void {
    const limit = this.now() - JOB_TTL_MS;
    for (const record of [...this.jobs.values()]) {
      if (record.startedMs < limit) this.drop(record);
    }
  }

  private drop(record: JobRecord): void {
    this.abort(record);
    this.jobs.delete(record.job.id);
  }

  private abort(record: JobRecord): void {
    if (record.job.status !== "running") return;
    this.settle(record, "cancelled", null);
    record.controller.abort();
  }

  private settle(record: JobRecord, status: Exclude<JarvisJob["status"], "running">, error: string | null, answer: JarvisAnswer | null = null): void {
    const { job } = record;
    if (job.status !== "running") return;
    for (const step of job.steps) {
      if (step.state !== "running") continue;
      step.state = status === "error" ? "error" : "skipped";
      if (status === "cancelled") step.detail = "annulé";
    }
    job.status = status;
    job.error = error;
    job.answer = answer;
    job.finishedAt = new Date(this.now()).toISOString();
  }

  private step(record: JobRecord, label: string, detail: string | null = null): StepHandle {
    if (record.job.status !== "running") throw new JarvisStopped();
    const step: JarvisStep = {
      id: `s${record.job.steps.length + 1}`,
      label,
      detail,
      state: "running",
      at: new Date(this.now()).toISOString(),
    };
    record.job.steps.push(step);
    const finish = (state: JarvisStep["state"], value: string | null | undefined) => {
      if (step.state !== "running") return;
      step.state = state;
      if (value !== undefined) step.detail = value;
    };
    return {
      done: (value) => finish("done", value),
      skip: (value) => finish("skipped", value),
      fail: (value) => finish("error", value),
    };
  }

  private ensureRunning(record: JobRecord): void {
    if (record.job.status !== "running" || record.controller.signal.aborted) throw new JarvisStopped();
  }

  private async run(record: JobRecord, input: JarvisAskInput): Promise<void> {
    let router: RouterRun | null = null;
    try {
      router = input.mode === "auto" ? this.startRouter(record, input) : null;
      const project = input.projectId ? this.deps.projects.get(input.projectId) : null;
      const builder = new JarvisContextBuilder(
        { ...this.deps, runningApplications: this.deps.runningApplications ?? listRunningApplications },
        { question: input.question, projectId: project?.id ?? null, conversationId: input.conversationId, history: input.history },
        new Date(this.now()),
      );
      let step = this.step(record, "Lire l'état des agents");
      const semantic = project && this.deps.semanticSearch ? this.semantic(input.question, project.id) : null;
      const live = builder.liveState();
      step.done(liveDetail(live));

      step = this.step(record, "Chercher dans les conversations");
      const text = builder.searchText();
      let candidates = builder.candidates(text, []);
      const total = count(text.total, "conversation", "conversations", "aucune conversation");
      step.done(text.terms.length > 0
        ? `${total}, ${count(candidates.length, "candidate", "candidates", "aucune candidate")}`
        : `${total}, aucun mot-clé à chercher`);

      step = this.step(record, "Lire les serveurs");
      const servers = builder.servers();
      step.done(count(servers.applications.length, "serveur actif", "serveurs actifs", "aucun serveur en écoute"));

      let hits: SemanticSearchHit[] = [];
      if (semantic && project) {
        step = this.step(record, `Recherche sémantique dans ${project.name}`);
        const outcome = await semantic;
        this.ensureRunning(record);
        if ("hits" in outcome) {
          hits = outcome.hits;
          candidates = builder.candidates(text, hits);
          step.done(`${count(hits.length, "conversation proche", "conversations proches", "rien de proche")} · ${count(candidates.length, "candidate", "candidates", "aucune candidate")} au total`);
        } else {
          step.skip(outcome.reason);
        }
      }

      const context = builder.assemble({ live, text, candidates, semantic: hits, servers });
      const cwd = project ? projectCwd(project) : homedir();

      step = this.step(record, "Choisir le modèle", router ? "Le routeur (Haiku 5.5, effort low) lit ta demande : réponse simple ou plan ?" : null);
      record.job.route = input.mode === "fast"
        ? route("haiku-5.5", "Mode rapide demandé : Haiku 5.5 répond seul.", "mode")
        : input.mode === "orchestrate"
          ? route("opus-5.5", "Mode orchestration demandé : Opus 5.5 prépare le plan.", "mode")
          : route("haiku-5.5", "Haiku 5.5 répond ; Opus 5.5 reprend si le routeur ou Haiku 5.5 voient un plan.", "haiku");
      if (!router) step.done(record.job.route.reason);
      const choosing = step;

      let draft: JarvisDraft | null = null;
      if (input.mode === "orchestrate") {
        draft = await this.draft(record, "opus-5.5", jarvisPrompt(context, { orchestrate: true }), context, cwd);
      } else {
        const handoff = new AbortController();
        let handoffReason: string | null = null;
        let handoffBy: "router" | "haiku" = "haiku";
        let haikuSettled = false;
        const escalate = (reason: string, by: "router" | "haiku") => {
          if (handoffReason !== null || haikuSettled) return;
          handoffReason = reason;
          handoffBy = by;
          handoff.abort();
        };
        const applyVerdict = ({ verdict, ms }: RouterOutcome) => {
          if (haikuSettled) return;
          if (verdict === null) {
            choosing.skip("Le routeur n'a pas tranché : Haiku 5.5 répond et passera la main si la demande appelle un plan.");
          } else if (verdict.plan) {
            choosing.done(`Plan demandé : Opus 5.5 prend la main · routeur en ${seconds(ms)}`);
            escalate(verdict.reason ?? "Le routeur juge que la demande appelle un plan.", "router");
          } else {
            choosing.done(`Réponse simple : Haiku 5.5 répond · routeur en ${seconds(ms)}`);
          }
        };
        if (router?.outcome) applyVerdict(router.outcome);
        else void router?.settled.then(applyVerdict);
        const watch = input.mode === "auto"
          ? (text: string) => {
              const reason = earlyEscalation(text);
              if (reason !== null) escalate(reason, "haiku");
            }
          : undefined;
        let haiku: JarvisDraft | null = null;
        if (handoffReason === null) {
          try {
            haiku = await this.draft(record, "haiku-5.5", jarvisPrompt(context, { orchestrate: false, handoff: input.mode === "auto" }), context, cwd, null, {
              signal: handoff.signal,
              onText: watch,
              handoffDetail: () => handoffBy === "router" ? "interrompu : le routeur demande un plan" : "passe la main à Opus 5.5 dès ses premiers mots",
            });
          } catch (error) {
            if (!(error instanceof JarvisHandoff)) throw error;
          }
        }
        haikuSettled = true;
        router?.stop.abort();
        if (haiku !== null) choosing.skip("Haiku 5.5 a répondu avant le routeur.");
        const reason = haiku === null ? handoffReason : input.mode === "auto" ? escalationReason(haiku) : null;
        if (haiku !== null) draft = haiku;
        if (reason) {
          record.job.route = route("opus-5.5", reason, haiku === null ? handoffBy : "haiku", true);
          try {
            draft = await this.draft(
              record,
              "opus-5.5",
              jarvisPrompt(context, haiku === null
                ? { orchestrate: true }
                : { orchestrate: true, draft: { json: draftJson(haiku), reason } }),
              context,
              cwd,
              reason,
            );
          } catch (error) {
            if (error instanceof JarvisStopped || haiku === null) throw error;
            record.job.route = route("haiku-5.5", "Opus 5.5 n'a pas abouti : la réponse de Haiku 5.5 est conservée.", "haiku");
          }
        } else if (input.mode === "auto") {
          record.job.route = route("haiku-5.5", "Question simple : Haiku 5.5 a suffi.", "haiku");
        }
      }

      if (draft === null) throw new JarvisModelError("Haiku 5.5 a passé la main sans qu'Opus 5.5 réponde.");
      step = this.step(record, "Vérifier la réponse");
      step.done(verifyDetail(draft));
      this.settle(record, "done", null, finalizeAnswer(draft, context, this.now() - record.startedMs));
    } catch (error) {
      if (error instanceof JarvisStopped || record.job.status !== "running") return;
      if (!(error instanceof JarvisModelError)) console.error("[jarvis] demande impossible", error);
      this.settle(record, "error", messageOf(error));
    } finally {
      router?.stop.abort();
    }
  }

  private startRouter(record: JobRecord, input: JarvisAskInput): RouterRun {
    const stop = new AbortController();
    const started = this.now();
    const run: RouterRun = { settled: Promise.resolve({ verdict: null, ms: 0 }), outcome: null, stop };
    run.settled = Promise.resolve()
      .then(() => this.deps.generate({
        model: "haiku-5.5",
        effort: "low",
        prompt: routerPrompt(input.question, input.history),
        cwd: homedir(),
        signal: AbortSignal.any([record.controller.signal, stop.signal, AbortSignal.timeout(ROUTER_TIMEOUT_MS)]),
      }))
      .then((raw) => parseRouterVerdict(raw), () => null)
      .then((verdict) => (run.outcome = { verdict, ms: this.now() - started }));
    return run;
  }

  private async draft(
    record: JobRecord,
    model: JarvisModel,
    prompt: string,
    context: JarvisContext,
    cwd: string,
    detail: string | null = null,
    extra: { signal?: AbortSignal; onText?: (text: string) => void; handoffDetail?: () => string } = {},
  ): Promise<JarvisDraft> {
    const { name, timeoutMs } = MODELS[model];
    const step = this.step(record, model === "opus-5.5" ? `${name} prépare le plan` : `${name} rédige la réponse`, detail);
    const started = this.now();
    const timeout = AbortSignal.timeout(timeoutMs);
    const signals = [record.controller.signal, timeout, ...(extra.signal ? [extra.signal] : [])];
    let raw: string;
    try {
      raw = await this.deps.generate({ model, prompt, cwd, signal: AbortSignal.any(signals), onText: extra.onText });
    } catch (error) {
      this.ensureRunning(record);
      if (extra.signal?.aborted) {
        step.done(`${seconds(this.now() - started)} · ${extra.handoffDetail?.() ?? "passe la main à Opus 5.5 dès ses premiers mots"}`);
        throw new JarvisHandoff();
      }
      const cause = timeout.aborted ? `pas de réponse en ${Math.round(timeoutMs / 1_000)} s` : messageOf(error);
      step.fail(cause);
      throw new JarvisModelError(`${name} : ${cause}`);
    }
    this.ensureRunning(record);
    const parsed = parseModelJson(raw);
    if (!parsed) {
      const prose = raw.trim();
      if (!prose || prose.includes("{")) {
        step.fail("réponse illisible");
        throw new JarvisModelError(`Réponse illisible de ${name}.`);
      }
      step.done(`${seconds(this.now() - started)} · réponse sans JSON`);
      return { text: clipText(prose, 700), results: [], actions: [], needsOrchestration: false, orchestrationReason: null, dropped: [] };
    }
    step.done(seconds(this.now() - started));
    return sanitizeDraft(parsed, context, (projectId, key) => this.ticketKey(projectId, key));
  }

  private ticketKey(projectId: string, key: string): string | null {
    const row = this.deps.db.query("SELECT key FROM tickets WHERE project_id = ? AND UPPER(key) = UPPER(?)")
      .get(projectId, key.trim()) as { key: string } | null;
    return row?.key ?? null;
  }

  private semantic(question: string, projectId: string): Promise<{ hits: SemanticSearchHit[] } | { reason: string }> {
    const timeoutMs = this.deps.semanticTimeoutMs ?? SEMANTIC_TIMEOUT_MS;
    const search = this.deps.semanticSearch!.search(question, projectId)
      .then((response) => ({ hits: response.results }))
      .catch((error: unknown) => ({
        reason: error instanceof SemanticSearchUnavailable ? error.message : `indisponible : ${messageOf(error)}`,
      }));
    const timeout = new Promise<{ reason: string }>((resolve) => {
      setTimeout(() => resolve({ reason: `plus de ${Math.round(timeoutMs / 1_000)} s : ignorée` }), timeoutMs).unref?.();
    });
    return Promise.race([search, timeout]);
  }
}
