import type { AppEvent, Provider } from "./events";
import { createHash } from "node:crypto";
import { runClaudeTurn } from "./adapters/claude";
import { runCodexTurn } from "./adapters/codex";
import { runCodexAppServerTurn } from "./adapters/codex-app-server";
import type { QuotaTracker } from "./quotas";
import type { Conversation, ConversationStore } from "./stores/conversations";
import type { ProjectStore } from "./stores/projects";
import { defaultReviewConfig } from "./stores/presets";
import type {
  CounterVerdict,
  Review,
  ReviewFlag,
  ReviewFlagInput,
  ReviewSeverity,
  ReviewStore,
} from "./stores/reviews";
import { MAX_CONCURRENT_SUBTASKS, SubtaskLimitError } from "./subtasks";
import type { SubtaskResult, SubtaskRunner } from "./subtasks";
import { conversationCwd } from "./workspace";

const DEFAULT_ZONE_CHARS = 48_000;
const DEFAULT_DIFF_MAX_BYTES = 2 * 1024 * 1024;
const CONVERSATION_BASE_REF = "CONVERSATION";
const WORKTREE_HEAD_REF = "WORKTREE";
const WORKTREE_CAPTURE_ATTEMPTS = 3;
// `core.quotePath` est actif par défaut : sans lui, Git rend `données.ts` sous
// forme échappée en octal et plus aucun flag du modèle ne s'y ancre.
const GIT_GLOBAL_ARGS = ["-c", "core.quotePath=false"];
const SEVERITIES = new Set<ReviewSeverity>(["red", "orange", "grey"]);

export interface ReviewScanInput {
  cwd: string;
  provider: Provider;
  model: string;
  effort: string;
  speed?: "standard" | "fast";
  prompt: string;
}

export type ReviewScanner = (input: ReviewScanInput) => Promise<string>;

export interface StartReviewInput {
  projectId: string;
  conversationId: string;
  gitRefBase: string;
  gitRefHead: string;
  provider: Provider;
  model: string;
  effort: string;
  speed?: "standard" | "fast";
  codeProvider?: Provider;
  scope?: string;
  incremental?: boolean;
}

export interface CounterOpinionConfig {
  model?: string;
  effort?: string;
  codeProvider?: Provider;
}

export interface CounterOpinionDefaults {
  provider: Provider;
  model: string;
  effort: string;
}

type CounterSubtasks = Pick<SubtaskRunner, "start" | "waitResult">;

export interface ReviewProgress {
  reviewId: string;
  projectId: string;
  zoneDone: number;
  zoneTotal: number;
}

type ReviewStatusListener = () => void;

interface CapturedDiff {
  base: string;
  head: string;
  diff: string;
}

export function dispatchAgentConfig(
  conversation: Pick<Conversation, "provider" | "model" | "effort" | "speed">,
  provider: Provider,
): { provider: Provider; model: string; effort: string; speed: "standard" | "fast" | null } {
  if (conversation.provider === provider) {
    const fallback = defaultReviewConfig(provider);
    return {
      provider,
      model: conversation.model,
      effort: conversation.effort ?? fallback.effort,
      speed: provider === "codex" ? (conversation.speed ?? "standard") : null,
    };
  }
  const fallback = defaultReviewConfig(provider);
  return { ...fallback, speed: provider === "codex" ? "standard" : null };
}

export interface CorrectionAgentConfig {
  provider: Provider;
  model: string;
  effort: string;
  speed: "standard" | "fast" | null;
}

class ReviewOutputError extends Error {}
export class DispatchConflictError extends Error {}

export class ReviewRunner {
  private active = new Map<string, Promise<void>>();
  private activeCounters = new Map<string, Promise<void>>();
  private activeDispatches = new Map<string, Promise<void>>();
  private progress = new Map<string, ReviewProgress>();
  private statusListeners = new Set<ReviewStatusListener>();
  private scanner: ReviewScanner;

  constructor(
    private store: ReviewStore,
    private projects: ProjectStore,
    private conversations: ConversationStore,
    private quotas: QuotaTracker,
    scanner?: ReviewScanner,
    private subtasks?: CounterSubtasks,
  ) {
    this.scanner = scanner ?? ((input) => scanWithAdapters(input, this.quotas));
  }

  start(input: StartReviewInput): Review {
    const project = this.projects.get(input.projectId);
    if (!project) throw new Error("projet inconnu");
    const conversation = this.conversations.get(input.conversationId);
    if (!conversation || conversation.project_id !== project.id) {
      throw new Error("conversation inconnue pour ce projet");
    }
    const scope = input.scope ?? "worktree";
    const parent = input.incremental ? this.store.latestDone(input.projectId, scope) : null;
    const review = this.store.create({
      ...input,
      codeProvider: input.codeProvider ?? conversation.provider,
      scope,
      parentReviewId: parent?.id ?? null,
    });
    this.progress.set(review.id, { reviewId: review.id, projectId: project.id, zoneDone: 0, zoneTotal: 0 });
    const run = this.execute(review.id, conversationCwd(project, conversation), { ...input, scope, parentReviewId: parent?.id ?? null })
      .catch((error) => {
        this.store.fail(review.id, errorMessage(error));
        this.progress.delete(review.id);
        this.notifyStatus();
      })
      .finally(() => {
        this.active.delete(review.id);
      });
    this.active.set(review.id, run);
    this.notifyStatus();
    return review;
  }

  subscribeStatus(listener: ReviewStatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  reviewStatus(projectId: string): {
    openBySeverity: Record<ReviewSeverity, number>;
    running: { reviewId: string; zoneDone: number; zoneTotal: number } | null;
  } | null {
    if (!this.projects.get(projectId)) return null;
    const snapshot = this.store.reviewStatus(projectId);
    const running = [...this.progress.values()].find((item) => item.projectId === projectId) ?? null;
    return { ...snapshot, running: running && {
      reviewId: running.reviewId, zoneDone: running.zoneDone, zoneTotal: running.zoneTotal,
    } };
  }

  get(id: string): Review | null {
    return this.store.get(id);
  }

  listByProject(projectId: string): Review[] {
    return this.store.listByProject(projectId);
  }

  getFlag(id: string): ReviewFlag | null {
    return this.store.getFlag(id);
  }

  setFlagStatus(id: string, status: "open" | "agent_running" | "treated" | "ignored" | "resolved") {
    const flag = this.store.setFlagStatus(id, status);
    if (flag) this.notifyStatus();
    return flag;
  }

  setFlagCodeProvider(id: string, provider: Provider) {
    return this.store.setFlagCodeProvider(id, provider);
  }

  updateFlag(
    id: string,
    input: {
      status?: "open" | "agent_running" | "treated" | "ignored" | "resolved";
      codeProvider?: Provider;
      hunkHash?: string | null;
      subtaskId?: string | null;
      userMessage?: string | null;
    },
  ) {
    const flag = this.store.updateFlag(id, input);
    if (flag) this.notifyStatus();
    return flag;
  }

  dispatchFlag(id: string, message?: string, agentConfig?: CorrectionAgentConfig): { subtaskId: string } {
    if (!this.subtasks) throw new Error("moteur de sous-tâches indisponible");
    const flag = this.store.getFlag(id);
    if (!flag) throw new Error("flag inconnu");
    if (flag.status !== "open" && flag.status !== "countered") {
      throw new DispatchConflictError("ce flag ne peut pas être dispatché dans son état actuel");
    }
    const review = this.store.get(flag.review_id);
    if (!review) throw new Error("review inconnue");
    const conversationId = review.conversation_id;
    const userMessage = message?.trim() || undefined;
    const run = this.executeDispatch(review, flag, conversationId, userMessage, agentConfig)
      .catch(() => {})
      .finally(() => this.activeDispatches.delete(id));
    // executeDispatch starts synchronously until its first await (the subtask is
    // created before waiting), so retrieve its persisted id immediately.
    const started = this.store.getFlag(id);
    if (!started?.subtask_id) throw new Error("échec du lancement de la sous-tâche");
    this.activeDispatches.set(id, run);
    return { subtaskId: started.subtask_id };
  }

  dispatchAll(
    reviewId: string,
    severities: ReviewSeverity[] = ["red", "orange"],
    agentConfig?: CorrectionAgentConfig,
  ): number {
    const review = this.store.get(reviewId);
    if (!review) throw new Error("review inconnu");
    const flags = review.flags.filter((flag) =>
      severities.includes(flag.severity) && (flag.status === "open" || flag.status === "countered"),
    );
    const targetConversation = review.conversation_id;
    void (async () => {
      for (let index = 0; index < flags.length; index += MAX_CONCURRENT_SUBTASKS) {
        const chunk = flags.slice(index, index + MAX_CONCURRENT_SUBTASKS);
        await Promise.all(chunk.map(async (flag) => {
          const run = this.executeDispatch(review, flag, targetConversation, undefined, agentConfig)
            .catch(() => {})
            .finally(() => this.activeDispatches.delete(flag.id));
          this.activeDispatches.set(flag.id, run);
          await run;
        }));
      }
    })();
    return flags.length;
  }

  private notifyStatus(): void {
    for (const listener of this.statusListeners) listener();
  }

  counterDefaults(flagId: string): CounterOpinionDefaults | null {
    const flag = this.store.getFlag(flagId);
    if (!flag) return null;
    return defaultReviewConfig(oppositeProvider(flag.code_provider));
  }

  startCounterOpinions(
    flagIds: string[],
    config: CounterOpinionConfig = {},
  ): ReviewFlag[] {
    if (!this.subtasks) throw new Error("moteur de sous-tâches indisponible");
    const uniqueIds = [...new Set(flagIds)];
    if (uniqueIds.length === 0) throw new Error("aucun flag à contre-expertiser");
    const flags = uniqueIds.map((id) => {
      const flag = this.store.getFlag(id);
      if (!flag) throw new Error("flag inconnu");
      return flag;
    });
    const reviewIds = new Set(flags.map((flag) => flag.review_id));
    if (reviewIds.size !== 1) throw new Error("les flags doivent appartenir à la même review");
    const review = this.store.get(flags[0]!.review_id);
    if (!review) throw new Error("review inconnue");
    if (config.codeProvider && flags.length !== 1) {
      throw new Error("l'auteur ne peut être précisé que pour un contre-avis ciblé");
    }
    const effectiveFlags = flags.map((flag) => ({
      ...flag,
      code_provider: config.codeProvider ?? flag.code_provider,
    }));
    const targetProviders = new Set(
      effectiveFlags.map((flag) => oppositeProvider(flag.code_provider)),
    );
    if (targetProviders.size > 1 && (config.model || config.effort)) {
      throw new Error("une review multi-provider utilise les modèles forts par défaut de chaque point");
    }
    const queued = this.store.queueCounters(effectiveFlags.map((flag) => {
      const defaults = defaultReviewConfig(oppositeProvider(flag.code_provider));
      return {
        id: flag.id,
        provider: defaults.provider,
        model: config.model?.trim() || defaults.model,
        effort: config.effort?.trim() || defaults.effort,
        codeProvider: flag.code_provider,
      };
    }));
    const run = this.executeCounterBatch(review, queued)
      .finally(() => {
        for (const flag of queued) this.activeCounters.delete(flag.id);
      });
    for (const flag of queued) this.activeCounters.set(flag.id, run);
    return queued;
  }

  async waitCounter(flagId: string): Promise<ReviewFlag | null> {
    await this.activeCounters.get(flagId);
    return this.store.getFlag(flagId);
  }

  async wait(id: string): Promise<Review | null> {
    await this.active.get(id);
    return this.store.get(id);
  }

  private async execute(
    id: string,
    cwd: string,
    input: StartReviewInput & { parentReviewId?: string | null },
  ): Promise<void> {
    const maxBytes = positiveEnv("PUPITRE_REVIEW_DIFF_MAX_BYTES", DEFAULT_DIFF_MAX_BYTES);
    const { base, head, diff } = input.gitRefHead === WORKTREE_HEAD_REF
      ? await this.captureWorktree(cwd, input, maxBytes)
      : await this.captureRange(cwd, input, maxBytes);
    this.store.setDiff(id, base, head, diff);
    const parent = input.parentReviewId ? this.store.get(input.parentReviewId) : null;
    const unchanged = parent?.flags.filter((flag) =>
      flag.hunk_hash !== null && flag.hunk_hash === hunkHashFor(diff, flag.file, flag.line_start),
    ) ?? [];
    if (unchanged.length > 0) this.store.copyFlags(id, unchanged);
    const resolved = parent?.flags.filter((flag) =>
      flag.subtask_id !== null
      && flag.hunk_hash !== null
      && flag.hunk_hash !== hunkHashFor(diff, flag.file, flag.line_start),
    ) ?? [];
    if (diff.trim() === "") {
      this.store.complete(id, []);
      this.store.copyFlags(id, resolved);
      this.markResolved(id, resolved);
      this.progress.delete(id);
      this.notifyStatus();
      return;
    }
    const scanDiff = filterUnchangedHunks(diff, unchanged);
    if (scanDiff.trim() === "") {
      this.store.complete(id, []);
      this.store.copyFlags(id, resolved);
      this.markResolved(id, resolved);
      this.progress.delete(id);
      this.notifyStatus();
      return;
    }

    const zones = splitDiffIntoZones(scanDiff);
    this.progress.set(id, { reviewId: id, projectId: input.projectId, zoneDone: 0, zoneTotal: zones.length });
    this.notifyStatus();
    const flags: ReviewFlagInput[] = [];
    for (const [index, zone] of zones.entries()) {
      const prompt = reviewPrompt(zone, index + 1, zones.length);
      flags.push(...await this.scanZone({
        cwd,
        provider: input.provider,
        model: input.model,
        effort: input.effort,
        speed: input.speed,
        prompt,
      }, zone));
      const current = this.progress.get(id);
      if (current) {
        current.zoneDone = index + 1;
        this.notifyStatus();
      }
    }
    const uniqueFlags = deduplicateFlags(flags);
    this.store.complete(id, uniqueFlags.map((flag) => ({
      ...flag,
      hunk_hash: hunkHashFor(diff, flag.file, flag.line_start),
    })));
    const rescannedHunks = new Set(uniqueFlags.map((flag) => hunkHashFor(diff, flag.file, flag.line_start)));
    const resolvedWithoutResignal = resolved.filter((flag) =>
      !rescannedHunks.has(hunkHashFor(diff, flag.file, flag.line_start)),
    );
    this.store.copyFlags(id, resolvedWithoutResignal);
    this.markResolved(id, resolvedWithoutResignal);
    const project = this.projects.get(input.projectId);
    if (project?.auto_counter_red && this.subtasks) {
      const redIds = this.store.get(id)?.flags
        .filter((flag) => flag.severity === "red")
        .map((flag) => flag.id) ?? [];
      if (redIds.length > 0) this.startCounterOpinions(redIds);
    }
    this.progress.delete(id);
    this.notifyStatus();
  }

  private async executeDispatch(
    review: Review,
    flag: ReviewFlag,
    conversationId: string,
    userMessage: string | undefined,
    agentConfig?: CorrectionAgentConfig,
  ): Promise<void> {
    try {
      const conversation = this.conversations.get(conversationId);
      if (!conversation) throw new Error("conversation inconnue");
      const agent = agentConfig ?? dispatchAgentConfig(conversation, flag.code_provider);
      let subtask;
      for (;;) {
        try {
          subtask = this.subtasks!.start({
            conversationId,
            provider: agent.provider,
            model: agent.model,
            effort: agent.effort,
            speed: agent.speed,
            prompt: dispatchPrompt(flag, counterContext(review.diff_text, flag), userMessage),
            label: `Gardien · ${flag.category} · ${flag.file}:${flag.line_start}`,
            readOnly: false,
          });
          break;
        } catch (error) {
          if (!(error instanceof SubtaskLimitError)) throw error;
          await Bun.sleep(100);
        }
      }
      this.store.updateFlag(flag.id, {
        status: "agent_running", subtaskId: subtask.id, userMessage: userMessage ?? null,
      });
      this.notifyStatus();
      const result = await this.subtasks!.waitResult(subtask.id);
      if (!result || result.status !== "done") {
        this.store.updateFlag(flag.id, { status: "open" });
      } else {
        // La correction a fini, mais seul un nouveau scan peut confirmer que le
        // signalement est réellement résolu. `treated` exprime cet état sans
        // laisser l'interface croire que l'agent tourne encore.
        this.store.updateFlag(flag.id, { status: "treated" });
      }
      this.notifyStatus();
    } catch (error) {
      this.store.updateFlag(flag.id, { status: "open" });
      this.notifyStatus();
      throw error;
    }
  }

  private markResolved(reviewId: string, flags: ReviewFlag[]): void {
    for (const flag of flags) {
      const copied = this.store.get(reviewId)?.flags.find((candidate) =>
        candidate.file === flag.file && candidate.line_start === flag.line_start && candidate.message === flag.message,
      );
      if (copied) this.store.setFlagStatus(copied.id, "resolved");
    }
  }

  // Le diff worktree est pris sur un dépôt vivant : HEAD peut bouger entre sa
  // lecture et la capture. On ne garde qu'un couple (SHA, diff) cohérent, sinon
  // la review serait archivée sous un commit qu'elle n'a jamais lu.
  private async captureWorktree(
    cwd: string,
    input: StartReviewInput,
    maxBytes: number,
  ): Promise<CapturedDiff> {
    for (let attempt = 0; attempt < WORKTREE_CAPTURE_ATTEMPTS; attempt += 1) {
      const head = await resolveGitRef(cwd, "HEAD");
      const base = await this.resolveBase(cwd, input, head);
      const diff = await worktreeDiff(cwd, base, maxBytes);
      if (await resolveGitRef(cwd, "HEAD") === head) return { base, head, diff };
    }
    throw new Error(
      "HEAD a changé pendant la capture du diff Gardien : relance la review une fois le dépôt stable",
    );
  }

  private async captureRange(
    cwd: string,
    input: StartReviewInput,
    maxBytes: number,
  ): Promise<CapturedDiff> {
    const head = await resolveGitRef(cwd, input.gitRefHead);
    const base = await this.resolveBase(cwd, input, head);
    const diff = await gitLimited(cwd, [
      "diff",
      "--no-ext-diff",
      "--unified=3",
      "--find-renames",
      `${base}...${head}`,
      "--",
    ], maxBytes);
    return { base, head, diff };
  }

  private async resolveBase(
    cwd: string,
    input: StartReviewInput,
    head: string,
  ): Promise<string> {
    return input.gitRefBase === CONVERSATION_BASE_REF
      ? await this.conversationBase(cwd, input.projectId, input.conversationId, head)
      : await resolveGitRef(cwd, input.gitRefBase);
  }

  private async conversationBase(
    cwd: string,
    projectId: string,
    conversationId: string,
    head: string,
  ): Promise<string> {
    const linked = this.store.linkedCommitShas(projectId, conversationId);
    const reachable: string[] = [];
    for (const sha of linked) {
      if (await gitSucceeds(cwd, ["merge-base", "--is-ancestor", sha, head])) {
        reachable.push(sha);
      }
    }
    if (reachable.length === 0) return head;

    const common = reachable.length === 1
      ? reachable[0]!
      : (await git(cwd, ["merge-base", "--octopus", ...reachable])).trim();
    if (!reachable.includes(common)) return common;
    try {
      return await resolveGitRef(cwd, `${common}^`);
    } catch {
      return (await git(cwd, ["hash-object", "-t", "tree", "/dev/null"])).trim();
    }
  }

  private async executeCounterBatch(review: Review, flags: ReviewFlag[]): Promise<void> {
    for (let index = 0; index < flags.length; index += MAX_CONCURRENT_SUBTASKS) {
      const chunk = flags.slice(index, index + MAX_CONCURRENT_SUBTASKS);
      await Promise.all(chunk.map((flag) => this.executeCounter(review, flag)));
    }
  }

  private async executeCounter(review: Review, flag: ReviewFlag): Promise<void> {
    try {
      let subtask;
      for (;;) {
        try {
          subtask = this.subtasks!.start({
            conversationId: review.conversation_id,
            provider: flag.counter_provider!,
            model: flag.counter_model!,
            effort: flag.counter_effort,
            prompt: counterOpinionPrompt(review, flag),
            label: `Contre-avis · ${flag.file}:${flag.line_start}`,
            readOnly: true,
          });
          break;
        } catch (error) {
          if (!(error instanceof SubtaskLimitError)) throw error;
          await Bun.sleep(100);
        }
      }
      this.store.beginCounter(flag.id, subtask.id);
      const result = await this.subtasks!.waitResult(subtask.id);
      if (!result || result.status !== "done") {
        throw new Error(counterResultError(result));
      }
      const opinion = parseCounterOpinionOutput(result.resultText);
      this.store.completeCounter(flag.id, opinion.verdict, opinion.text);
    } catch (error) {
      this.store.failCounter(flag.id, errorMessage(error));
    }
  }

  private async scanZone(input: ReviewScanInput, diff: string): Promise<ReviewFlagInput[]> {
    let response = await this.scanner(input);
    try {
      return parseReviewOutput(response, diff);
    } catch (error) {
      if (!(error instanceof ReviewOutputError)) throw error;
      response = await this.scanner({
        ...input,
        prompt: formatRetryPrompt(input.prompt, response, error.message),
      });
      return parseReviewOutput(response, diff);
    }
  }

}

export function parseCounterOpinionOutput(output: string): {
  verdict: CounterVerdict;
  text: string;
} {
  const parsed = parseJsonObject(output);
  if (
    parsed.verdict !== "confirmed"
    && parsed.verdict !== "dismissed"
    && parsed.verdict !== "nuanced"
  ) {
    throw new ReviewOutputError("verdict de contre-avis invalide");
  }
  return {
    verdict: parsed.verdict,
    text: nonEmptyString(parsed.text, "texte du contre-avis"),
  };
}

export async function scanWithAdapters(
  input: ReviewScanInput,
  quotas: QuotaTracker,
): Promise<string> {
  const finals: string[] = [];
  const deltas: string[] = [];
  let terminalError: string | null = null;
  const emit = (event: AppEvent) => {
    quotas.ingest(event);
    if (event.type === "text-final") finals.push(event.text);
    if (event.type === "text-delta") deltas.push(event.text);
    if (event.type === "status" && event.state === "error") {
      terminalError = event.error ?? "échec du modèle de review";
    }
  };
  const options = {
    cwd: input.cwd,
    model: input.model,
    effort: input.effort,
    speed: input.speed,
    prompt: input.prompt,
    cliSessionId: null,
    // Claude ne peut pas éditer en mode plan ; Codex reçoit en plus son sandbox.
    permissionMode: "plan",
    sandboxMode: "read-only" as const,
    images: [],
  };
  if (input.provider === "claude") await runClaudeTurn(options, emit);
  else if (process.env.PUPITRE_CODEX_MODE === "exec") await runCodexTurn(options, emit);
  else await runCodexAppServerTurn(options, emit);
  if (terminalError !== null) throw new Error(terminalError);
  const output = finals.at(-1)?.trim() || deltas.join("").trim();
  if (!output) throw new Error("sortie vide du modèle de review");
  return output;
}

export function splitDiffIntoZones(diff: string, maxChars = DEFAULT_ZONE_CHARS): string[] {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) {
    throw new Error("taille de zone de review invalide");
  }
  const patches = diff.split(/(?=^diff --git )/m)
    .filter((patch) => patch.trim() !== "")
    .flatMap((patch) => splitOversizedPatch(patch, maxChars));
  if (patches.length === 0) return diff.trim() ? [diff] : [];
  const zones: string[] = [];
  let current = "";
  for (const patch of patches) {
    if (current && current.length + patch.length > maxChars) {
      zones.push(current);
      current = "";
    }
    current += patch;
  }
  if (current) zones.push(current);
  return zones;
}

/** Hash stable du hunk (en-tête et contenu) ancré à une ligne du fichier. */
export function hunkHashFor(diff: string, file: string, line: number): string | null {
  const hunk = findHunk(diff, file, line);
  return hunk ? createHash("sha1").update(hunk).digest("hex") : null;
}

function findHunk(diff: string, targetFile: string, targetLine: number): string | null {
  let oldFile: string | null = null;
  let file: string | null = null;
  let hunkStart = -1;
  let oldCursor = 0;
  let newCursor = 0;
  let hunkContains = false;
  const lines = diff.split("\n");
  const finish = (end: number) => hunkStart >= 0 && hunkContains
    ? lines.slice(hunkStart, end).join("\n")
    : null;
  for (let index = 0; index <= lines.length; index += 1) {
    const value = lines[index];
    if (index === lines.length || value?.startsWith("diff --git ") || value?.startsWith("@@ ")) {
      const found = finish(index);
      if (found) return found;
      hunkStart = -1;
      hunkContains = false;
      if (index === lines.length) break;
      if (value!.startsWith("diff --git ")) {
        oldFile = null;
        file = null;
      }
      if (value!.startsWith("@@ ")) {
        const match = value!.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (match) {
          hunkStart = index;
          oldCursor = Number(match[1]);
          newCursor = Number(match[2]);
        }
      }
      continue;
    }
    if (hunkStart < 0) {
      if (value!.startsWith("--- ")) {
        const path = value!.slice(4).trim();
        oldFile = path === "/dev/null" ? null : normalizedPath(path);
      } else if (value!.startsWith("+++ ")) {
        const path = value!.slice(4).trim();
        file = path === "/dev/null" ? oldFile : normalizedPath(path);
      }
      continue;
    }
    if (value!.startsWith("+")) {
      if (file === targetFile && newCursor === targetLine) hunkContains = true;
      newCursor += 1;
    } else if (value!.startsWith("-")) {
      if (file === targetFile && oldCursor === targetLine) hunkContains = true;
      oldCursor += 1;
    } else if (!value!.startsWith("\\")) {
      if (file === targetFile && newCursor === targetLine) hunkContains = true;
      oldCursor += 1;
      newCursor += 1;
    }
  }
  return null;
}

function filterUnchangedHunks(diff: string, flags: ReviewFlag[]): string {
  if (flags.length === 0) return diff;
  const hashes = new Set(flags.map((flag) => flag.hunk_hash).filter((hash): hash is string => hash !== null));
  const patches = diff.split(/(?=^diff --git )/m).filter((patch) => patch.trim() !== "");
  return patches.map((patch) => {
    const lines = patch.split("\n");
    const firstHunk = lines.findIndex((line) => line.startsWith("@@ "));
    if (firstHunk < 0) return patch;
    const preamble = lines.slice(0, firstHunk);
    const hunks: string[][] = [];
    for (const line of lines.slice(firstHunk)) {
      if (line.startsWith("@@ ")) hunks.push([line]);
      else hunks.at(-1)!.push(line);
    }
    const file = patch.match(/^\+\+\+ b\/(.+)$/m)?.[1] ?? patch.match(/^--- a\/(.+)$/m)?.[1];
    if (!file) return patch;
    return [
      ...preamble,
      ...hunks.filter((hunk) => !hashes.has(createHash("sha1").update(hunk.join("\n")).digest("hex"))).flat(),
    ].join("\n");
  }).filter((patch) => /@@ /m.test(patch)).join("\n");
}

function splitOversizedPatch(patch: string, maxChars: number): string[] {
  if (patch.length <= maxChars) return [patch];
  const lines = patch.split("\n");
  const firstHunk = lines.findIndex((line) => line.startsWith("@@ "));
  if (firstHunk < 0) throw new Error("patch Git trop volumineux sans hunk découpable");
  const preamble = `${lines.slice(0, firstHunk).join("\n")}\n`;
  if (preamble.length >= maxChars) throw new Error("en-tête de patch Git trop volumineux");
  const hunks: string[][] = [];
  for (const line of lines.slice(firstHunk)) {
    if (line.startsWith("@@ ")) hunks.push([line]);
    else hunks.at(-1)!.push(line);
  }
  return hunks.flatMap((hunk) => splitOversizedHunk(preamble, hunk, maxChars));
}

function splitOversizedHunk(preamble: string, hunk: string[], maxChars: number): string[] {
  const match = hunk[0]!.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
  if (!match) throw new Error("hunk Git invalide");
  const suffix = match[5] ?? "";
  let oldCursor = Number(match[1]);
  let newCursor = Number(match[3]);
  const result: string[] = [];
  let body: string[] = [];
  let chunkOld = oldCursor;
  let chunkNew = newCursor;

  const render = (lines: string[]) => {
    let oldCount = 0;
    let newCount = 0;
    for (const line of lines) {
      if (!line.startsWith("+") && !line.startsWith("\\")) oldCount += 1;
      if (!line.startsWith("-") && !line.startsWith("\\")) newCount += 1;
    }
    const header = `@@ -${chunkOld},${oldCount} +${chunkNew},${newCount} @@${suffix}\n`;
    return `${preamble}${header}${lines.join("\n")}\n`;
  };

  const flush = () => {
    if (body.length === 0) return;
    result.push(render(body));
    chunkOld = oldCursor;
    chunkNew = newCursor;
    body = [];
  };

  for (const line of hunk.slice(1)) {
    const probe = [...body, line];
    if (render(probe).length > maxChars) {
      if (body.length === 0) throw new Error("ligne de diff trop volumineuse pour le Gardien");
      flush();
      if (render([line]).length > maxChars) {
        throw new Error("ligne de diff trop volumineuse pour le Gardien");
      }
    }
    body.push(line);
    if (!line.startsWith("+") && !line.startsWith("\\")) oldCursor += 1;
    if (!line.startsWith("-") && !line.startsWith("\\")) newCursor += 1;
  }
  flush();
  if (result.some((zone) => zone.length > maxChars)) {
    throw new Error("hunk Git impossible à découper dans la limite configurée");
  }
  return result;
}

export function parseReviewOutput(output: string, diff: string): ReviewFlagInput[] {
  const parsed = parseJsonObject(output);
  if (!Array.isArray(parsed.flags)) {
    throw new ReviewOutputError("la clé flags doit être un tableau");
  }
  const changed = changedLines(diff);
  return parsed.flags.map((raw, index) => validateFlag(raw, index, changed));
}

function parseJsonObject(output: string): Record<string, unknown> {
  const candidates = [
    ...[...output.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1] ?? ""),
  ];
  const firstBrace = output.indexOf("{");
  const lastBrace = output.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(output.slice(firstBrace, lastBrace + 1));
  }
  candidates.push(output.trim());
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate) as unknown;
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    } catch {
      // On essaie le candidat suivant (fence, sous-chaîne, puis sortie entière).
    }
  }
  throw new ReviewOutputError("aucun objet JSON valide trouvé");
}

function validateFlag(
  raw: unknown,
  index: number,
  changed: Map<string, Set<number>>,
): ReviewFlagInput {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ReviewOutputError(`flag ${index + 1} invalide`);
  }
  const flag = raw as Record<string, unknown>;
  const file = normalizedPath(flag.file);
  const lineStart = positiveInteger(flag.line_start, `flag ${index + 1}.line_start`);
  const lineEnd = positiveInteger(flag.line_end, `flag ${index + 1}.line_end`);
  if (lineEnd < lineStart) {
    throw new ReviewOutputError(`flag ${index + 1} : intervalle de lignes inversé`);
  }
  if (typeof flag.severity !== "string" || !SEVERITIES.has(flag.severity as ReviewSeverity)) {
    throw new ReviewOutputError(`flag ${index + 1}.severity invalide`);
  }
  const category = nonEmptyString(flag.category, `flag ${index + 1}.category`);
  const message = nonEmptyString(flag.message, `flag ${index + 1}.message`);
  if (flag.test_gap !== undefined && typeof flag.test_gap !== "boolean") {
    throw new ReviewOutputError(`flag ${index + 1}.test_gap invalide`);
  }
  const lines = changed.get(file);
  if (!lines || ![...lines].some((line) => line >= lineStart && line <= lineEnd)) {
    throw new ReviewOutputError(
      `flag ${index + 1} non ancré à une ligne modifiée de ${file}`,
    );
  }
  return {
    file,
    line_start: lineStart,
    line_end: lineEnd,
    severity: flag.severity as ReviewSeverity,
    category,
    message,
    ...(typeof flag.test_gap === "boolean" ? { test_gap: flag.test_gap } : {}),
  };
}

interface DiffChange {
  /** Index de la ligne dans `diff.split("\n")`. */
  index: number;
  file: string;
  /** Ligne NEW pour un ajout, ligne OLD pour une suppression. */
  line: number;
}

/**
 * Parcourt un patch unifié en distinguant en-tête et contenu par leur position
 * et non par leur préfixe : à l'intérieur d'un hunk, `--- x` et `+++ x` sont du
 * contenu (commentaire SQL, front-matter Markdown, patch versionné) et non des
 * en-têtes de fichier. Les traiter comme des en-têtes décalait les curseurs de
 * lignes, voire faisait échouer toute la review sur un chemin fantaisiste.
 */
function walkDiffChanges(diff: string, visit: (change: DiffChange) => void): void {
  let oldFile: string | null = null;
  let file: string | null = null;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const [index, line] of diff.split("\n").entries()) {
    if (line.startsWith("diff --git ")) {
      oldFile = null;
      file = null;
      inHunk = false;
      continue;
    }
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk) {
      if (line.startsWith("--- ")) {
        const path = line.slice(4).trim();
        oldFile = path === "/dev/null" ? null : normalizedPath(path);
      } else if (line.startsWith("+++ ")) {
        const path = line.slice(4).trim();
        file = path === "/dev/null" ? oldFile : normalizedPath(path);
      }
      continue;
    }
    if (line.startsWith("+")) {
      const changed = newLine++;
      if (file) visit({ index, file, line: changed });
    } else if (line.startsWith("-")) {
      const changed = oldLine++;
      if (file) visit({ index, file, line: changed });
    } else if (!line.startsWith("\\")) {
      oldLine += 1;
      newLine += 1;
    }
  }
}

function changedLines(diff: string): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  walkDiffChanges(diff, ({ file, line }) => {
    const lines = result.get(file) ?? new Set<number>();
    lines.add(line);
    result.set(file, lines);
  });
  return result;
}

function normalizedPath(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ReviewOutputError("chemin de flag invalide");
  }
  let path = value.trim();
  if (path.startsWith("a/") || path.startsWith("b/")) path = path.slice(2);
  if (path.startsWith("/") || path.split("/").includes("..")) {
    throw new ReviewOutputError("chemin de flag hors projet");
  }
  return path;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new ReviewOutputError(`${field} invalide`);
  }
  return Number(value);
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ReviewOutputError(`${field} invalide`);
  }
  return value.trim();
}

function reviewPrompt(diff: string, index: number, total: number): string {
  return [
    "Tu es le Gardien de Pupitre. Fais une review de risques, pas un résumé du diff.",
    `Zone ${index}/${total}. Analyse uniquement les lignes modifiées ci-dessous.`,
    "Grille obligatoire : perte de données ; side effects sur modules partagés ;",
    "changement de contrat d'API ; migration ou schéma ; comportement modifié",
    "silencieusement ; gestion d'erreur supprimée ; secret ou credential ; absence",
    "de test sur code critique.",
    "Chaque flag doit être concret, actionnable et ancré à des lignes modifiées.",
    "Marque test_gap=true uniquement quand le risque est une couverture de test absente ou insuffisante.",
    "Sévérité : red = prod/données, orange = side effect probable, grey = cosmétique.",
    "Réponds UNIQUEMENT par ce JSON, sans markdown ni commentaire :",
    '{"flags":[{"file":"src/fichier.ts","line_start":12,"line_end":14,',
    '"severity":"red|orange|grey","category":"catégorie",',
    '"message":"Une phrase concrète et actionnable.","test_gap":true|false}]}',
    "S'il n'y a aucun risque réel, réponds exactement {\"flags\":[]}.",
    "",
    diff,
  ].join("\n");
}

function formatRetryPrompt(original: string, response: string, reason: string): string {
  return [
    original,
    "",
    "CORRECTION DE FORMAT : ta réponse précédente est inexploitable.",
    `Cause : ${reason}.`,
    "Retourne maintenant uniquement l'objet JSON demandé, avec des flags ancrés",
    "aux lignes modifiées. Aucun texte avant ou après.",
    "Réponse précédente :",
    response.slice(0, 4_000),
  ].join("\n");
}


function oppositeProvider(provider: Provider): Provider {
  return provider === "claude" ? "codex" : "claude";
}

function counterResultError(result: SubtaskResult | null): string {
  if (!result) return "sous-tâche de contre-avis introuvable";
  return result.error || `contre-avis terminé avec le statut ${result.status}`;
}

function counterOpinionPrompt(review: Review, flag: ReviewFlag): string {
  return [
    "Tu rends un contre-avis de code indépendant. Ton objectif est la certitude,",
    "pas la chasse au faux positif ni la contradiction systématique.",
    `Le code de ce point a été écrit par ${flag.code_provider}. Rejuge uniquement ce signal :`,
    `Fichier : ${flag.file}:${flag.line_start}-${flag.line_end}`,
    `Sévérité initiale : ${flag.severity}`,
    `Catégorie : ${flag.category}`,
    `Signal : ${flag.message}`,
    "Confirme, infirme ou nuance le risque à partir du diff ci-dessous.",
    "N'utilise aucun outil d'écriture et ne modifie aucun fichier.",
    "Réponds UNIQUEMENT par ce JSON :",
    '{"verdict":"confirmed|dismissed|nuanced","text":"Explication concrète et concise."}',
    "",
    counterContext(review.diff_text, flag),
  ].join("\n");
}

function dispatchPrompt(flag: ReviewFlag, context: string, userMessage: string | undefined): string {
  return [
    `Le Gardien a signalé un risque ${flag.severity} dans ${flag.file}:${flag.line_start} :`,
    flag.message,
    userMessage ? `\nConsigne de l'utilisateur : ${userMessage}` : "",
    "\nZone concernée (diff, ±30 lignes) :",
    context,
    "\nTraite ce point directement dans le code. Modifie les fichiers nécessaires,",
    "ajoute ou adapte les tests, et termine par un résumé d'une ligne de ce que tu as changé.",
  ].join("\n");
}

function counterContext(diff: string, flag: ReviewFlag): string {
  const patches = diff.split(/(?=^diff --git )/m).filter((patch) => patch.trim() !== "");
  const patch = patches.find((candidate) => {
    const firstLine = candidate.split("\n", 1)[0] ?? "";
    return firstLine.includes(` a/${flag.file} `) || firstLine.endsWith(` b/${flag.file}`);
  });
  if (!patch || patch.length <= DEFAULT_ZONE_CHARS) return patch ?? diff.slice(0, DEFAULT_ZONE_CHARS);

  const lines = patch.split("\n");
  let anchor = -1;
  walkDiffChanges(patch, ({ index, line }) => {
    if (anchor >= 0) return;
    if (line >= flag.line_start && line <= flag.line_end) anchor = index;
  });
  if (anchor < 0) return patch.slice(0, DEFAULT_ZONE_CHARS);
  const start = Math.max(0, anchor - 30);
  const end = Math.min(lines.length, anchor + 31);
  return [lines[0], ...lines.slice(start, end)].filter(Boolean).join("\n");
}

function deduplicateFlags(flags: ReviewFlagInput[]): ReviewFlagInput[] {
  const unique = new Map<string, ReviewFlagInput>();
  for (const flag of flags) {
    const key = [flag.file, flag.line_start, flag.line_end, flag.severity, flag.message].join("\0");
    unique.set(key, flag);
  }
  return [...unique.values()];
}

async function resolveGitRef(cwd: string, ref: string): Promise<string> {
  if (!ref.trim() || ref.length > 200 || ref.includes("\0")) throw new Error("ref git invalide");
  return (await git(cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).trim();
}

async function git(cwd: string, args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...GIT_GLOBAL_ARGS, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args[0]} a échoué : ${stderr.trim() || `code ${exitCode}`}`);
  }
  return stdout;
}

async function gitSucceeds(cwd: string, args: string[]): Promise<boolean> {
  const child = Bun.spawn(["git", ...GIT_GLOBAL_ARGS, ...args], {
    cwd,
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  return await child.exited === 0;
}

async function gitLimited(
  cwd: string,
  args: string[],
  maxBytes: number,
  acceptedExitCodes: readonly number[] = [0],
): Promise<string> {
  const child = Bun.spawn(["git", ...GIT_GLOBAL_ARGS, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  const stderrPromise = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let exceeded = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        exceeded = true;
        child.kill();
        break;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const [exitCode, stderr] = await Promise.all([child.exited, stderrPromise]);
  if (exceeded) throw new Error(`diff trop volumineux pour le Gardien (plus de ${maxBytes} octets)`);
  if (!acceptedExitCodes.includes(exitCode)) {
    throw new Error(`git ${args[0]} a échoué : ${stderr.trim() || `code ${exitCode}`}`);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(output);
}

async function worktreeDiff(cwd: string, base: string, maxBytes: number): Promise<string> {
  // Les fichiers non suivis sont listés AVANT le diff des fichiers suivis. Un
  // `git add` concurrent — geste banal d'un agent en fin de tour — ferait
  // autrement disparaître le fichier des deux sorties : `git diff <base>` ne
  // l'a pas encore vu et `ls-files --others` ne le voit déjà plus. Dans cet
  // ordre, il apparaît au pire deux fois, ce qui est sans danger pour l'ancrage.
  const untrackedOutput = await gitLimited(
    cwd,
    ["ls-files", "--others", "--exclude-standard", "-z"],
    maxBytes,
  );
  const untracked = untrackedOutput.split("\0").filter(Boolean);
  const tracked = await gitLimited(cwd, [
    "diff",
    "--no-ext-diff",
    "--unified=3",
    "--find-renames",
    base,
    "--",
  ], maxBytes);
  let used = Buffer.byteLength(tracked);
  const parts = tracked ? [tracked] : [];
  for (const path of untracked) {
    const separator = parts.length > 0 ? "\n" : "";
    const remaining = maxBytes - used - Buffer.byteLength(separator);
    if (remaining <= 0) {
      throw new Error(`diff trop volumineux pour le Gardien (plus de ${maxBytes} octets)`);
    }
    const patch = await gitLimited(cwd, [
      "diff",
      "--no-index",
      "--no-ext-diff",
      "--unified=3",
      "--",
      "/dev/null",
      path,
    ], remaining, [0, 1]);
    parts.push(patch);
    used += Buffer.byteLength(separator) + Buffer.byteLength(patch);
  }
  return parts.join("\n");
}

function positiveEnv(key: string, fallback: number): number {
  const value = Number(process.env[key]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
