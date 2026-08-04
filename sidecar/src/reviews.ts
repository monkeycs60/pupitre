import type { AppEvent, Provider } from "./events";
import { runClaudeTurn } from "./adapters/claude";
import { runCodexTurn } from "./adapters/codex";
import { runCodexAppServerTurn } from "./adapters/codex-app-server";
import type { QuotaTracker } from "./quotas";
import type { ConversationStore } from "./stores/conversations";
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
import { MAX_CONCURRENT_SUBTASKS } from "./subtasks";
import type { SubtaskResult, SubtaskRunner } from "./subtasks";

const DEFAULT_ZONE_CHARS = 48_000;
const DEFAULT_DIFF_MAX_BYTES = 2 * 1024 * 1024;
const SEVERITIES = new Set<ReviewSeverity>(["red", "orange", "grey"]);

export interface ReviewScanInput {
  cwd: string;
  provider: Provider;
  model: string;
  effort: string;
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
}

export interface CounterOpinionConfig {
  model?: string;
  effort?: string;
}

export interface CounterOpinionDefaults {
  provider: Provider;
  model: string;
  effort: string;
}

type CounterSubtasks = Pick<SubtaskRunner, "start" | "waitResult">;

class ReviewOutputError extends Error {}

export class ReviewRunner {
  private active = new Map<string, Promise<void>>();
  private activeCounters = new Map<string, Promise<void>>();
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
    const review = this.store.create(input);
    const run = this.execute(review.id, project.path, input)
      .catch((error) => {
        this.store.fail(review.id, errorMessage(error));
      })
      .finally(() => {
        this.active.delete(review.id);
      });
    this.active.set(review.id, run);
    return review;
  }

  get(id: string): Review | null {
    return this.store.get(id);
  }

  listByProject(projectId: string): Review[] {
    return this.store.listByProject(projectId);
  }

  setFlagStatus(id: string, status: "open" | "acked" | "dismissed") {
    return this.store.setFlagStatus(id, status);
  }

  gardienStatus(projectId: string) {
    const project = this.projects.get(projectId);
    if (!project) return null;
    return this.store.gardienStatus(projectId, project.gardien_mode);
  }

  counterDefaults(flagId: string): CounterOpinionDefaults | null {
    const flag = this.store.getFlag(flagId);
    if (!flag) return null;
    const review = this.store.get(flag.review_id);
    if (!review) return null;
    return defaultReviewConfig(oppositeProvider(review.code_provider));
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
    const defaults = defaultReviewConfig(oppositeProvider(review.code_provider));
    const selected = {
      provider: defaults.provider,
      model: config.model?.trim() || defaults.model,
      effort: config.effort?.trim() || defaults.effort,
    };
    const queued = flags.map((flag) => this.store.queueCounter(
      flag.id,
      selected.provider,
      selected.model,
      selected.effort,
    )!);
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

  private async execute(id: string, cwd: string, input: StartReviewInput): Promise<void> {
    const [base, head] = await Promise.all([
      resolveGitRef(cwd, input.gitRefBase),
      resolveGitRef(cwd, input.gitRefHead),
    ]);
    const diff = await git(cwd, [
      "diff",
      "--no-ext-diff",
      "--unified=3",
      "--find-renames",
      `${base}...${head}`,
      "--",
    ]);
    const maxBytes = positiveEnv("PUPITRE_REVIEW_DIFF_MAX_BYTES", DEFAULT_DIFF_MAX_BYTES);
    if (Buffer.byteLength(diff) > maxBytes) {
      throw new Error(`diff trop volumineux pour le Gardien (${Buffer.byteLength(diff)} octets)`);
    }
    this.store.setDiff(id, base, head, diff);
    if (diff.trim() === "") {
      this.store.complete(id, []);
      return;
    }

    const zones = splitDiffIntoZones(diff);
    const flags: ReviewFlagInput[] = [];
    for (const [index, zone] of zones.entries()) {
      const prompt = reviewPrompt(zone, index + 1, zones.length);
      flags.push(...await this.scanZone({
        cwd,
        provider: input.provider,
        model: input.model,
        effort: input.effort,
        prompt,
      }, zone));
    }
    this.store.complete(id, deduplicateFlags(flags));
    const project = this.projects.get(input.projectId);
    if (project?.auto_counter_red && this.subtasks) {
      const redIds = this.store.get(id)?.flags
        .filter((flag) => flag.severity === "red")
        .map((flag) => flag.id) ?? [];
      if (redIds.length > 0) this.startCounterOpinions(redIds);
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
      const subtask = this.subtasks!.start({
        conversationId: review.conversation_id,
        provider: flag.counter_provider!,
        model: flag.counter_model!,
        effort: flag.counter_effort,
        prompt: counterOpinionPrompt(review, flag),
        label: `Contre-avis · ${flag.file}:${flag.line_start}`,
        readOnly: true,
      });
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
  const patches = diff.split(/(?=^diff --git )/m).filter((patch) => patch.trim() !== "");
  if (patches.length === 0) return diff.trim() ? [diff] : [];
  const zones: string[] = [];
  let current = "";
  for (const patch of patches) {
    if (current && current.length + patch.length > maxChars) {
      zones.push(current);
      current = "";
    }
    // Un fichier reste atomique : couper au milieu d'un hunk enlèverait au
    // reviewer ses numéros de lignes et son contexte d'ancrage.
    current += patch;
  }
  if (current) zones.push(current);
  return zones;
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
  };
}

function changedLines(diff: string): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  let oldFile: string | null = null;
  let file: string | null = null;
  let oldLine = 0;
  let newLine = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("--- ")) {
      const path = line.slice(4).trim();
      oldFile = path === "/dev/null" ? null : normalizedPath(path);
      continue;
    }
    if (line.startsWith("+++ ")) {
      const path = line.slice(4).trim();
      file = path === "/dev/null" ? oldFile : normalizedPath(path);
      if (file && !result.has(file)) result.set(file, new Set());
      continue;
    }
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    if (!file || line.startsWith("diff --git")) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      result.get(file)!.add(newLine++);
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      result.get(file)!.add(oldLine++);
    } else if (!line.startsWith("\\")) {
      oldLine += 1;
      newLine += 1;
    }
  }
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
    "Sévérité : red = prod/données, orange = side effect probable, grey = cosmétique.",
    "Réponds UNIQUEMENT par ce JSON, sans markdown ni commentaire :",
    '{"flags":[{"file":"src/fichier.ts","line_start":12,"line_end":14,',
    '"severity":"red|orange|grey","category":"catégorie",',
    '"message":"Une phrase concrète et actionnable."}]}',
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
    `Le code a été écrit par ${review.code_provider}. Rejuge uniquement ce signal :`,
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

function counterContext(diff: string, flag: ReviewFlag): string {
  const patches = diff.split(/(?=^diff --git )/m).filter((patch) => patch.trim() !== "");
  const patch = patches.find((candidate) => {
    const firstLine = candidate.split("\n", 1)[0] ?? "";
    return firstLine.includes(` a/${flag.file} `) || firstLine.endsWith(` b/${flag.file}`);
  });
  if (!patch || patch.length <= DEFAULT_ZONE_CHARS) return patch ?? diff.slice(0, DEFAULT_ZONE_CHARS);

  const lines = patch.split("\n");
  let oldLine = 0;
  let newLine = 0;
  let anchor = -1;
  for (const [index, line] of lines.entries()) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    let changedLine: number | null = null;
    if (line.startsWith("+") && !line.startsWith("+++")) changedLine = newLine++;
    else if (line.startsWith("-") && !line.startsWith("---")) changedLine = oldLine++;
    else if (line.startsWith(" ")) {
      oldLine += 1;
      newLine += 1;
    }
    if (changedLine !== null && changedLine >= flag.line_start && changedLine <= flag.line_end) {
      anchor = index;
      break;
    }
  }
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
  const child = Bun.spawn(["git", ...args], {
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

function positiveEnv(key: string, fallback: number): number {
  const value = Number(process.env[key]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
