import { homedir } from "node:os";
import { generateWithAdapters, prewarmWithAdapters } from "./debriefs";
import { apiCost, openAiUsage, type JarvisCost } from "./jarvis-cost";
import {
  draftJson,
  escalationReason,
  finalizeAnswer,
  jarvisPrompt,
  parseModelJson,
  sanitizeDraft,
  type JarvisAnswer,
  type JarvisDraft,
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
import type { JarvisRouter, RouterVerdict } from "./jarvis-router";
import type { QuotaTracker } from "./quotas";
import { listRunningApplications, type ApplicationContext, type RunningApplication } from "./running-applications";
import { SemanticSearchUnavailable, type SemanticSearch, type SemanticSearchHit } from "./semantic-search";
import { projectCwd } from "./workspace";

export type { JarvisAction, JarvisAnswer, JarvisResult } from "./jarvis-answer";
export type { JarvisCost } from "./jarvis-cost";

export type JarvisMode = "auto" | "fast" | "orchestrate";
export type JarvisModel = "qwen-3.8" | "haiku-5.5" | "opus-5.5";

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
  /** Qui a choisi le modèle : le mode imposé, le modèle rapide en lisant les données, ou Jev en amont. */
  by: "mode" | "fast" | "router";
}

/** Conversation trouvée par la recherche sémantique, montrée avant la réponse du modèle. */
export interface JarvisPreview {
  conversationId: string;
  projectId: string;
  projectName: string;
  title: string;
  reason: string;
  score: number | null;
}

export interface JarvisJob {
  id: string;
  status: "running" | "done" | "error" | "cancelled";
  steps: JarvisStep[];
  route: JarvisRoute | null;
  preview: JarvisPreview[];
  costs: JarvisCost[];
  answer: JarvisAnswer | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface JarvisGenerationInput {
  model: JarvisModel;
  prompt: string;
  cwd: string;
  signal: AbortSignal;
  onText?: (text: string) => void;
  onCost?: (cost: JarvisCost) => void;
}

export type JarvisGenerator = (input: JarvisGenerationInput) => Promise<string>;

export interface JarvisDeps extends Omit<JarvisContextDeps, "runningApplications"> {
  generate: JarvisGenerator;
  /** Modèle du premier passage ; Haiku 5.5 sans lui. */
  fastModel?: () => JarvisModel;
  /** Lance d'avance le process du modèle qui répondra en premier. */
  prewarm?: (input: { model: JarvisModel; cwd: string }) => void;
  /** Décide avant le modèle rapide si une demande appelle un plan ; sans lui, le modèle rapide répond d'abord. */
  router?: JarvisRouter;
  semanticSearch?: Pick<SemanticSearch, "search">;
  runningApplications?: (contexts: ApplicationContext[]) => RunningApplication[];
  now?: () => number;
  semanticTimeoutMs?: number;
}

export class JarvisInputError extends Error {}

/** Le modèle rapide a annoncé en tête de réponse qu'il fallait un plan : on l'arrête pour lancer Opus aussitôt. */
class JarvisHandoff extends Error {}

export const MAX_QUESTION_CHARS = 2_000;
const MAX_HISTORY_ENTRIES = 6;
const MAX_HISTORY_CHARS = 4_000;
const JOB_TTL_MS = 30 * 60_000;
const MAX_JOBS = 50;
const SEMANTIC_TIMEOUT_MS = 4_000;
const ROUTER_TIMEOUT_MS = 5_000;
const CEREBRAS_CHAT_URL = "https://api.cerebras.ai/v1/chat/completions";
const CEREBRAS_MODEL = "qwen-3.8-27b";

const MODELS: Record<JarvisModel, { name: string; label: string; timeoutMs: number }> = {
  "qwen-3.8": { name: "Qwen 3.8", label: "Qwen 3.8 · Cerebras", timeoutMs: 20_000 },
  "haiku-5.5": { name: "Haiku 5.5", label: "Haiku 5.5 · rapide", timeoutMs: 90_000 },
  "opus-5.5": { name: "Opus 5.5", label: "Opus 5.5 · orchestration", timeoutMs: 240_000 },
};

/**
 * `mcpServers: {}` devient `--strict-mcp-config` sur une liste vide : aucun
 * serveur MCP, pas même ceux de l'utilisateur, que le CLI chargerait tous si
 * le champ manquait.
 */
export function claudeJarvisGenerator(quotas: QuotaTracker): JarvisGenerator {
  return ({ model, prompt, cwd, signal, onText, onCost }) => generateWithAdapters({
    cwd,
    provider: "claude",
    model,
    effort: "high",
    prompt,
    signal,
    mcpServers: {},
    oneShot: true,
    onText,
    onUsage: (usage) => {
      if (usage.costUsd === undefined) return;
      onCost?.({
        label: `${MODELS[model].name} · ${model === "opus-5.5" ? "plan" : "réponse"}`,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        usd: usage.costUsd,
        billing: "subscription",
      });
    },
  }, quotas);
}

export function cerebrasJarvisGenerator(apiKey: () => string | null, fetchImpl: typeof fetch = fetch): JarvisGenerator {
  return async ({ prompt, signal, onCost }) => {
    const key = apiKey();
    if (!key) throw new Error("clé Cerebras absente");
    const response = await fetchImpl(CEREBRAS_CHAT_URL, {
      method: "POST",
      signal,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: CEREBRAS_MODEL,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!response.ok) throw new Error(`Cerebras HTTP ${response.status} : ${(await response.text()).slice(0, 200)}`);
    const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const usage = openAiUsage(CEREBRAS_MODEL, body);
    if (usage) onCost?.(apiCost(usage));
    return body.choices?.[0]?.message?.content ?? "";
  };
}

export function jarvisGenerator(quotas: QuotaTracker, cerebrasKey: () => string | null): JarvisGenerator {
  const claude = claudeJarvisGenerator(quotas);
  const cerebras = cerebrasJarvisGenerator(cerebrasKey);
  return (input) => input.model === "qwen-3.8" ? cerebras(input) : claude(input);
}

export function claudeJarvisPrewarm(): NonNullable<JarvisDeps["prewarm"]> {
  return ({ model, cwd }) => prewarmWithAdapters({ cwd, provider: "claude", model, effort: "high", mcpServers: {}, oneShot: true });
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

function percent(probability: number): string {
  return `${Math.round(probability * 100)} %`;
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
      preview: [],
      costs: [],
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

  /** Préchauffe le modèle que le mode choisi appellera en premier, dans le dossier du projet ouvert. */
  warm(projectId: string | null, mode: JarvisAskInput["mode"]): void {
    if (!this.deps.prewarm) return;
    const model = mode === "orchestrate" ? "opus-5.5" : this.fastModel();
    if (model === "qwen-3.8") return;
    const project = projectId ? this.deps.projects.get(projectId) : null;
    this.deps.prewarm({ model, cwd: project ? projectCwd(project) : homedir() });
  }

  private fastModel(): JarvisModel {
    return this.deps.fastModel?.() ?? "haiku-5.5";
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
      router = input.mode === "auto" && this.deps.router?.ready() ? this.startRouter(record, input, this.deps.router) : null;
      const project = input.projectId ? this.deps.projects.get(input.projectId) : null;
      const builder = new JarvisContextBuilder(
        { ...this.deps, runningApplications: this.deps.runningApplications ?? listRunningApplications },
        { question: input.question, projectId: project?.id ?? null, conversationId: input.conversationId, history: input.history },
        new Date(this.now()),
      );
      let step = this.step(record, "Lire l'état des agents");
      const semantic = project && this.deps.semanticSearch ? this.semantic(record, input.question, project.id) : null;
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
          record.job.preview = hits.map(({ conversation, reason, score }) => ({
            conversationId: conversation.id,
            projectId: conversation.project_id,
            projectName: project.name,
            title: conversation.title,
            reason,
            score,
          }));
          candidates = builder.candidates(text, hits);
          step.done(`${count(hits.length, "conversation proche", "conversations proches", "rien de proche")} · ${count(candidates.length, "candidate", "candidates", "aucune candidate")} au total`);
        } else {
          step.skip(outcome.reason);
        }
      }

      const context = builder.assemble({ live, text, candidates, semantic: hits, servers });
      const cwd = project ? projectCwd(project) : homedir();

      const fast = this.fastModel();
      const fastName = MODELS[fast].name;
      step = this.step(record, "Choisir le modèle", router ? "Jev lit ta demande : réponse simple ou plan ?" : null);
      record.job.route = input.mode === "fast"
        ? route(fast, `Mode rapide demandé : ${fastName} répond seul.`, "mode")
        : input.mode === "orchestrate"
          ? route("opus-5.5", "Mode orchestration demandé : Opus 5.5 prépare le plan.", "mode")
          : route(fast, router
            ? `${fastName} répond ; Opus 5.5 reprend si Jev ou ${fastName} voient un plan.`
            : `${fastName} répond ; Opus 5.5 reprend si la demande appelle un plan.`, "fast");
      if (!router) {
        step.done(input.mode === "auto"
          ? `${record.job.route.reason} Sans clé TypeSafe, Jev ne trie pas la demande en amont.`
          : record.job.route.reason);
      }
      const choosing = step;

      let draft: JarvisDraft | null = null;
      if (input.mode === "orchestrate") {
        draft = await this.draft(record, "opus-5.5", jarvisPrompt(context, { orchestrate: true }), context, cwd);
      } else {
        const handoff = new AbortController();
        let handoffReason: string | null = null;
        let handoffBy: "router" | "fast" = "fast";
        let firstSettled = false;
        const escalate = (reason: string, by: "router" | "fast") => {
          if (handoffReason !== null || firstSettled) return;
          handoffReason = reason;
          handoffBy = by;
          handoff.abort();
        };
        const applyVerdict = ({ verdict, ms }: RouterOutcome) => {
          if (firstSettled) return;
          if (verdict === null) {
            choosing.skip(`Jev n'a pas répondu : ${fastName} répond et passera la main si la demande appelle un plan.`);
          } else if (verdict.plan) {
            choosing.done(`Plan probable à ${percent(verdict.probability)} : Opus 5.5 prend la main · Jev en ${seconds(ms)}`);
            escalate(`Jev estime à ${percent(verdict.probability)} que la demande appelle un plan.`, "router");
          } else {
            choosing.done(`Réponse simple (plan probable à ${percent(verdict.probability)}) : ${fastName} répond · Jev en ${seconds(ms)}`);
          }
        };
        if (router?.outcome) applyVerdict(router.outcome);
        else void router?.settled.then(applyVerdict);
        let answered: JarvisModel = fast;
        const firstPass = (model: JarvisModel, detail: string | null) => this.draft(
          record,
          model,
          jarvisPrompt(context, { orchestrate: false, handoff: input.mode === "auto" }),
          context,
          cwd,
          detail,
          {
            signal: handoff.signal,
            onText: input.mode === "auto"
              ? (text: string) => {
                  const reason = earlyEscalation(text, MODELS[model].name);
                  if (reason !== null) escalate(reason, "fast");
                }
              : undefined,
            handoffDetail: () => handoffBy === "router" ? "interrompu : Jev demande un plan" : "passe la main à Opus 5.5 dès ses premiers mots",
          },
        );
        let first: JarvisDraft | null = null;
        if (handoffReason === null) {
          try {
            first = await firstPass(fast, null);
          } catch (error) {
            if (!(error instanceof JarvisModelError) || fast === "haiku-5.5") {
              if (!(error instanceof JarvisHandoff)) throw error;
            } else {
              answered = "haiku-5.5";
              const fallback = `${fastName} n'a pas abouti : Haiku 5.5 prend le relais.`;
              record.job.route = route("haiku-5.5", fallback, record.job.route?.by ?? "fast");
              try {
                first = await firstPass("haiku-5.5", fallback);
              } catch (retry) {
                if (!(retry instanceof JarvisHandoff)) throw retry;
              }
            }
          }
        }
        firstSettled = true;
        router?.stop.abort();
        const answeredName = MODELS[answered].name;
        if (first !== null) choosing.skip(`${answeredName} a répondu avant Jev.`);
        const reason = first === null ? handoffReason : input.mode === "auto" ? escalationReason(first, answeredName) : null;
        if (first !== null) draft = first;
        if (reason) {
          record.job.route = route("opus-5.5", reason, first === null ? handoffBy : "fast", true);
          try {
            draft = await this.draft(
              record,
              "opus-5.5",
              jarvisPrompt(context, first === null
                ? { orchestrate: true }
                : { orchestrate: true, draft: { json: draftJson(first), reason } }),
              context,
              cwd,
              reason,
            );
          } catch (error) {
            if (error instanceof JarvisStopped) throw error;
            if (first === null) {
              const fallback = `Opus 5.5 n'a pas abouti : ${answeredName} répond à sa place.`;
              record.job.route = route(answered, fallback, "fast");
              draft = await this.draft(record, answered, jarvisPrompt(context, { orchestrate: false }), context, cwd, fallback);
            } else {
              record.job.route = route(answered, `Opus 5.5 n'a pas abouti : la réponse de ${answeredName} est conservée.`, "fast");
            }
          }
        } else if (input.mode === "auto") {
          record.job.route = route(answered, `Question simple : ${answeredName} a suffi.`, "fast");
        }
      }

      if (draft === null) throw new JarvisModelError(`${fastName} a passé la main sans qu'Opus 5.5 réponde.`);
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

  private startRouter(record: JobRecord, input: JarvisAskInput, router: JarvisRouter): RouterRun {
    const stop = new AbortController();
    const started = this.now();
    const run: RouterRun = { settled: Promise.resolve({ verdict: null, ms: 0 }), outcome: null, stop };
    run.settled = Promise.resolve()
      .then(() => router.decide({
        question: input.question,
        history: input.history,
        signal: AbortSignal.any([record.controller.signal, stop.signal, AbortSignal.timeout(ROUTER_TIMEOUT_MS)]),
      }))
      .then((verdict): RouterVerdict | null => verdict, (error: unknown) => {
        if (!stop.signal.aborted && !record.controller.signal.aborted) console.error("[jarvis] routeur Jev", error);
        return null;
      })
      .then((verdict) => {
        if (verdict?.usage) record.job.costs.push(apiCost(verdict.usage));
        return (run.outcome = { verdict, ms: this.now() - started });
      });
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
      raw = await this.deps.generate({
        model,
        prompt,
        cwd,
        signal: AbortSignal.any(signals),
        onText: extra.onText,
        onCost: (cost) => record.job.costs.push(cost),
      });
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

  private semantic(record: JobRecord, question: string, projectId: string): Promise<{ hits: SemanticSearchHit[] } | { reason: string }> {
    const timeoutMs = this.deps.semanticTimeoutMs ?? SEMANTIC_TIMEOUT_MS;
    const search = this.deps.semanticSearch!.search(question, projectId)
      .then((response) => {
        for (const usage of response.usage ?? []) record.job.costs.push(apiCost(usage));
        return { hits: response.results };
      })
      .catch((error: unknown) => ({
        reason: error instanceof SemanticSearchUnavailable ? error.message : `indisponible : ${messageOf(error)}`,
      }));
    const timeout = new Promise<{ reason: string }>((resolve) => {
      setTimeout(() => resolve({ reason: `plus de ${Math.round(timeoutMs / 1_000)} s : ignorée` }), timeoutMs).unref?.();
    });
    return Promise.race([search, timeout]);
  }
}
