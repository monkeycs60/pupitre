import { runClaudeTurn } from "./adapters/claude";
import { runCodexTurn } from "./adapters/codex";
import { runCodexAppServerTurn } from "./adapters/codex-app-server";
import {
  ConversationActivity,
  ConversationBusyError,
} from "./conversation-activity";
import type { AppEvent, Provider, StoredEvent } from "./events";
import type { QuotaTracker } from "./quotas";
import type { ConversationStore } from "./stores/conversations";
import type { ProjectStore } from "./stores/projects";
import type { ReviewFlag, ReviewStore } from "./stores/reviews";
import {
  TestScopeAlreadyRunningError,
  type TestInventory,
  type TestMethod,
  type TestScope,
  type TestScopeInput,
  type TestingStore,
} from "./stores/testing";
import type { Subtask, SubtaskInput, SubtaskResult } from "./subtasks";

const MAX_INVENTORY_SOURCE_CHARS = 160_000;
const MAX_EVIDENCE_CHARS = 60_000;

type BroadcastFn = (conversationId: string, event: StoredEvent) => void;

export interface TestInventoryGenerationInput {
  cwd: string;
  provider: Provider;
  model: string;
  effort?: string;
  speed?: "standard" | "fast";
  prompt: string;
}

export type TestInventoryGenerator = (
  input: TestInventoryGenerationInput,
) => Promise<string>;

interface TestSubtasks {
  start(input: SubtaskInput): Subtask;
  waitResult(id: string): Promise<SubtaskResult | null>;
  cancel?(id: string): Promise<boolean>;
}

export class TesterBusyError extends Error {}

export class TesterRunner {
  private generator: TestInventoryGenerator;
  private runs = new Map<string, Promise<void>>();

  constructor(
    private store: TestingStore,
    private conversations: ConversationStore,
    private projects: ProjectStore,
    private reviews: ReviewStore,
    private quotas: QuotaTracker,
    private broadcast: BroadcastFn,
    private subtasks: TestSubtasks,
    generator?: TestInventoryGenerator,
    private activity = new ConversationActivity(),
  ) {
    this.generator = generator ?? ((input) => generateWithAdapters(input, this.quotas));
  }

  getInventory(id: string): TestInventory | null {
    return this.store.getInventory(id);
  }

  getScope(id: string): TestScope | null {
    return this.store.getScope(id);
  }

  async inventory(conversationId: string): Promise<TestInventory> {
    try {
      return await this.activity.runExclusive(conversationId, "test-inventory", async () => {
        const conversation = this.conversations.get(conversationId);
        if (!conversation) throw new Error("conversation inconnue");
        const project = this.projects.get(conversation.project_id);
        if (!project) throw new Error("projet inconnu");
        const events = this.conversations.listEvents(conversationId);
        const testingFlags = this.reviews.listTestingFlags(project.id);
        const knownFlagIds = new Set(testingFlags.map((flag) => flag.id));
        const output = await this.generator({
          cwd: project.path,
          provider: conversation.provider,
          model: conversation.model,
          effort: conversation.effort ?? undefined,
          speed: conversation.speed ?? undefined,
          prompt: inventoryPrompt(transcript(events), testingFlags),
        });
        const scopes = parseTestInventory(output, knownFlagIds);
        appendMissingGuardianScopes(scopes, testingFlags);
        const created = this.store.createWithReference({
          conversationId,
          eventIdFrom: events[0]?.id ?? 0,
          eventIdTo: events.at(-1)?.id ?? 0,
          scopes,
        });
        this.broadcast(conversationId, created.event);
        return created.inventory;
      });
    } catch (error) {
      if (error instanceof ConversationBusyError) throw new TesterBusyError(error.message);
      throw error;
    }
  }

  startScope(scopeId: string): TestScope {
    const current = this.store.getScope(scopeId);
    if (!current) throw new Error("scope de test inconnu");
    const inventory = this.store.getInventory(current.inventory_id)!;
    const conversation = this.conversations.get(inventory.conversation_id)!;
    let releaseActivity: () => void;
    try {
      releaseActivity = this.activity.acquire(conversation.id, "test-scope");
    } catch (error) {
      if (error instanceof ConversationBusyError) throw new TesterBusyError(error.message);
      throw error;
    }
    let reserved: TestScope;
    try {
      reserved = this.store.reserveScope(scopeId)!;
    } catch (error) {
      releaseActivity();
      throw error;
    }
    let subtask: Subtask;
    try {
      subtask = this.subtasks.start({
        conversationId: conversation.id,
        provider: conversation.provider,
        model: conversation.model,
        effort: conversation.effort,
        speed: conversation.speed,
        prompt: executionPrompt(reserved),
        label: `Test · ${reserved.title}`,
      });
    } catch (error) {
      const completed = this.store.completeScope({
        id: reserved.id,
        status: "failed",
        evidenceMd: "Le scope n'a pas pu démarrer.",
        error: error instanceof Error ? error.message : String(error),
        guardianFlagIdsAcked: [],
      });
      this.broadcast(conversation.id, completed.event);
      releaseActivity();
      throw error;
    }
    let attached: ReturnType<TestingStore["attachSubtask"]>;
    try {
      attached = this.store.attachSubtask(reserved.id, subtask.id);
    } catch (error) {
      void this.subtasks.cancel?.(subtask.id);
      const completed = this.store.completeScope({
        id: reserved.id,
        status: "failed",
        evidenceMd: "Le scope n'a pas pu être relié à sa sous-tâche.",
        error: error instanceof Error ? error.message : String(error),
        guardianFlagIdsAcked: [],
      });
      this.broadcast(conversation.id, completed.event);
      releaseActivity();
      throw error;
    }
    this.broadcast(conversation.id, attached.event);
    const run = this.finishScope(attached.scope, conversation.id, subtask.id)
      .catch((error) => console.error("Finalisation du scope de test impossible", error))
      .finally(() => {
        this.runs.delete(scopeId);
        releaseActivity();
      });
    this.runs.set(scopeId, run);
    return attached.scope;
  }

  async wait(scopeId: string): Promise<TestScope | null> {
    await this.runs.get(scopeId);
    return this.store.getScope(scopeId);
  }

  private async finishScope(
    scope: TestScope,
    conversationId: string,
    subtaskId: string,
  ): Promise<void> {
    let result: SubtaskResult | null = null;
    let waitError: string | null = null;
    try {
      result = await this.subtasks.waitResult(subtaskId);
    } catch (error) {
      waitError = error instanceof Error ? error.message : String(error);
    }
    const parsed = result?.status === "done" ? parseTestResult(result.resultText) : null;
    const passed = result?.status === "done" && parsed?.verdict === "passed";
    const evidence = evidenceMarkdown(result, parsed?.summary ?? null, passed);
    const completed = this.store.completeScope({
      id: scope.id,
      status: passed ? "passed" : "failed",
      evidenceMd: evidence,
      error: waitError ?? result?.error ?? (parsed ? null : "verdict structuré absent"),
      guardianFlagIdsAcked: [],
    }, passed ? () => this.reviews.ackFlags(scope.guardian_flag_ids) : undefined);
    this.broadcast(conversationId, completed.event);
  }
}

export function parseTestInventory(
  output: string,
  knownFlagIds: Set<string>,
): TestScopeInput[] {
  const parsed = JSON.parse(extractJson(output)) as { items?: unknown };
  if (!Array.isArray(parsed.items) || parsed.items.length > 12) {
    throw new Error("inventaire de test invalide");
  }
  return parsed.items.map((raw, index) => {
    if (!raw || typeof raw !== "object") throw new Error(`scope ${index + 1} invalide`);
    const item = raw as Record<string, unknown>;
    const title = boundedString(item.title, 160, `titre du scope ${index + 1}`);
    const description = boundedString(item.description, 1_500, `description du scope ${index + 1}`);
    if (!Array.isArray(item.methods) || item.methods.length === 0 || item.methods.length > 6) {
      throw new Error(`méthodes du scope ${index + 1} invalides`);
    }
    const methods = item.methods.map((rawMethod): TestMethod => {
      if (!rawMethod || typeof rawMethod !== "object") throw new Error("méthode invalide");
      const method = rawMethod as Record<string, unknown>;
      if (method.kind !== "unit" && method.kind !== "browser" && method.kind !== "manual") {
        throw new Error("type de méthode de test invalide");
      }
      return {
        kind: method.kind,
        label: boundedString(method.label, 180, "libellé de méthode"),
        instructions: boundedString(method.instructions, 2_000, "instructions de méthode"),
      };
    });
    const guardianFlagIds = Array.isArray(item.guardian_flag_ids)
      ? [...new Set(item.guardian_flag_ids.filter(
          (id): id is string => typeof id === "string" && knownFlagIds.has(id),
        ))]
      : [];
    return { title, description, methods, guardianFlagIds };
  });
}

function appendMissingGuardianScopes(scopes: TestScopeInput[], flags: ReviewFlag[]): void {
  const assigned = new Set(scopes.flatMap((scope) => scope.guardianFlagIds));
  for (const flag of flags) {
    if (assigned.has(flag.id) || scopes.length >= 12) continue;
    scopes.push({
      title: `Couvrir ${flag.file}:${flag.line_start}`,
      description: flag.message,
      methods: [{
        kind: "unit",
        label: "Test ciblé du risque Gardien",
        instructions: `Ajouter ou exécuter le test qui couvre ${flag.file}:${flag.line_start}-${flag.line_end}.`,
      }],
      guardianFlagIds: [flag.id],
    });
  }
}

function boundedString(value: unknown, max: number, label: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    throw new Error(`${label} invalide`);
  }
  return value.trim();
}

function extractJson(output: string): string {
  const trimmed = output.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced?.[1] ?? trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end < start) throw new Error("sortie JSON de test absente");
  return candidate.slice(start, end + 1);
}

function transcript(events: StoredEvent[]): string {
  const chunks = events.flatMap((event) => {
    const prefix = `[événement #${event.id}]`;
    switch (event.type) {
      case "user-message": return [`${prefix} Utilisateur : ${event.text}`];
      case "text-final": return [`${prefix} Agent : ${event.text}`];
      case "tool-start": return [`${prefix} Outil ${event.toolName} : ${JSON.stringify(event.input)}`];
      case "tool-end": return [`${prefix} Preuve outil : ${event.output}`];
      case "debrief-ref": return [`${prefix} Débrief : ${event.contentMd}`];
      case "test-scope-result": return [`${prefix} Test ${event.status} : ${event.evidenceMd}`];
      default: return [];
    }
  }).map((chunk) => chunk.length > 8_000 ? `${chunk.slice(0, 8_000)}\n[…]` : chunk);
  const joined = chunks.join("\n\n");
  if (joined.length <= MAX_INVENTORY_SOURCE_CHARS) return joined;
  const half = Math.floor(MAX_INVENTORY_SOURCE_CHARS / 2);
  return `${joined.slice(0, half)}\n\n[… historique intermédiaire tronqué …]\n\n${joined.slice(-half)}`;
}

function inventoryPrompt(source: string, flags: ReviewFlag[]): string {
  return [
    "Relis la conversation et produis un inventaire concret de ce qui a été implémenté et est testable.",
    "N'exécute aucun outil. Retourne uniquement un objet JSON de cette forme :",
    '{"items":[{"title":"...","description":"...","methods":[{"kind":"unit|browser|manual","label":"...","instructions":"..."}],"guardian_flag_ids":["..."]}]}',
    "Chaque item doit représenter un scope choisissable. Donne des pistes précises adaptées au projet.",
    "Réutilise uniquement les ids Gardien listés ci-dessous et rattache-les au scope qui les vérifiera.",
    "",
    "FLAGS GARDIEN LIÉS AUX TESTS",
    flags.length === 0
      ? "Aucun."
      : flags.map((flag) =>
          `- ${flag.id} · ${flag.file}:${flag.line_start}-${flag.line_end} · ${flag.message}`,
        ).join("\n"),
    "",
    "CONVERSATION",
    source || "Conversation sans événement textuel exploitable.",
  ].join("\n");
}

function executionPrompt(scope: TestScope): string {
  return [
    "Tu exécutes un scope de validation choisi explicitement par l'utilisateur.",
    "Ne modifie pas le code produit sauf si une étape de test l'exige strictement; ne committe rien.",
    "Collecte des preuves: sorties de commandes complètes, étapes reproduites et screenshots pour tout parcours navigateur.",
    "À la fin, rends un bref compte-rendu puis termine exactement par :",
    '<test-result>{"verdict":"passed|failed","summary":"résumé factuel des preuves"}</test-result>',
    "Un verdict passed exige que les vérifications prévues aient réellement été exécutées et réussies.",
    "",
    `SCOPE : ${scope.title}`,
    scope.description,
    "",
    "PISTES",
    ...scope.methods.map((method) =>
      `- [${method.kind}] ${method.label} : ${method.instructions}`,
    ),
  ].join("\n");
}

function parseTestResult(output: string): { verdict: "passed" | "failed"; summary: string } | null {
  const match = output.match(/<test-result>\s*([\s\S]*?)\s*<\/test-result>/i);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]!) as Record<string, unknown>;
    if (parsed.verdict !== "passed" && parsed.verdict !== "failed") return null;
    if (typeof parsed.summary !== "string" || parsed.summary.trim() === "") return null;
    return { verdict: parsed.verdict, summary: parsed.summary.trim() };
  } catch {
    return null;
  }
}

function evidenceMarkdown(
  result: SubtaskResult | null,
  summary: string | null,
  passed: boolean,
): string {
  const raw = result?.resultText.trim() || result?.error || "Aucune preuve produite.";
  const clipped = raw.length > MAX_EVIDENCE_CHARS
    ? `${raw.slice(0, MAX_EVIDENCE_CHARS)}\n\n[… preuves tronquées …]`
    : raw;
  return [
    `## Verdict · ${passed ? "réussi" : "échec"}`,
    summary ?? result?.error ?? "Le scope ne fournit pas de verdict structuré exploitable.",
    "",
    "## Preuves",
    clipped,
  ].join("\n");
}

async function generateWithAdapters(
  input: TestInventoryGenerationInput,
  quotas: QuotaTracker,
): Promise<string> {
  const deltas: string[] = [];
  let final = "";
  let providerError: string | null = null;
  const emit = (event: AppEvent) => {
    quotas.ingest(event);
    if (event.type === "text-delta") deltas.push(event.text);
    if (event.type === "text-final") final = event.text;
    if (event.type === "status" && event.state === "error") {
      providerError = event.error ?? "échec du modèle";
    }
  };
  const options = {
    cwd: input.cwd,
    model: input.model,
    effort: input.effort,
    speed: input.speed,
    prompt: input.prompt,
    cliSessionId: null,
    permissionMode: "plan",
    sandboxMode: "read-only" as const,
    images: [],
  };
  if (input.provider === "claude") await runClaudeTurn(options, emit);
  else if (process.env.PUPITRE_CODEX_MODE === "exec") await runCodexTurn(options, emit);
  else await runCodexAppServerTurn(options, emit);
  if (providerError !== null) throw new Error(providerError);
  return final || deltas.join("");
}

export { TestScopeAlreadyRunningError };
