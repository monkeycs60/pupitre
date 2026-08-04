import { runClaudeTurn } from "./adapters/claude";
import { runCodexTurn } from "./adapters/codex";
import { runCodexAppServerTurn } from "./adapters/codex-app-server";
import type { AppEvent, Provider, StoredEvent } from "./events";
import type { QuotaTracker } from "./quotas";
import type { ConversationStore } from "./stores/conversations";
import type { Debrief, DebriefStore } from "./stores/debriefs";
import type { ProjectStore } from "./stores/projects";
import {
  ConversationActivity,
  ConversationBusyError,
} from "./conversation-activity";

const MAX_TRANSCRIPT_CHARS = 180_000;
const MAX_EVENT_CHARS = 8_000;
const MAX_HANDOFF_CHARS = 120_000;
const MAX_GENERATED_DEBRIEF_CHARS = 32_000;
const MAX_CONSOLIDATION_SOURCE_CHARS = 100_000;

type BroadcastFn = (conversationId: string, event: StoredEvent) => void;

export interface DebriefGenerationInput {
  cwd: string;
  provider: Provider;
  model: string;
  effort?: string;
  speed?: "standard" | "fast";
  prompt: string;
}

export interface HandoffDebriefArtifact {
  latest: Debrief;
  contentMd: string;
}

export type DebriefGenerator = (input: DebriefGenerationInput) => Promise<string>;

export class DebriefAlreadyRunningError extends Error {}
export class NoNewDebriefEventsError extends Error {}

export class DebriefRunner {
  private active = new Set<string>();
  private generator: DebriefGenerator;

  constructor(
    private store: DebriefStore,
    private conversations: ConversationStore,
    private projects: ProjectStore,
    private quotas: QuotaTracker,
    private broadcast: BroadcastFn,
    generator?: DebriefGenerator,
    private activity = new ConversationActivity(),
  ) {
    this.generator = generator ?? ((input) => generateWithAdapters(input, this.quotas));
  }

  isRunning(conversationId: string): boolean {
    return this.active.has(conversationId);
  }

  get(id: string): Debrief | null {
    return this.store.get(id);
  }

  latest(conversationId: string): Debrief | null {
    return this.store.latest(conversationId);
  }

  listByConversation(conversationId: string): Debrief[] {
    return this.store.listByConversation(conversationId);
  }

  async generate(conversationId: string): Promise<Debrief> {
    try {
      return await this.activity.runExclusive(
        conversationId,
        "debrief",
        () => this.generateUnlocked(conversationId),
      );
    } catch (error) {
      if (error instanceof ConversationBusyError) {
        throw new DebriefAlreadyRunningError(error.message);
      }
      throw error;
    }
  }

  private async generateUnlocked(conversationId: string): Promise<Debrief> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) throw new Error("conversation inconnue");
    const project = this.projects.get(conversation.project_id);
    if (!project) throw new Error("projet inconnu");

    const previous = this.store.latest(conversationId);
    const candidates = this.conversations.listEvents(conversationId)
      .filter((event) => event.id > (previous?.event_id_to ?? 0))
      .filter((event) => event.type !== "debrief-ref");
    const transcriptChunks = transcriptChunksFor(candidates);
    if (candidates.length === 0 || transcriptChunks.length === 0) {
      throw new NoNewDebriefEventsError("aucun nouvel événement à débriefer");
    }

    this.active.add(conversationId);
    try {
      const generation = {
        cwd: project.path,
        provider: conversation.provider,
        model: conversation.model,
        effort: conversation.effort ?? undefined,
        speed: conversation.speed ?? undefined,
      };
      const partials: string[] = [];
      for (const transcript of transcriptChunks) {
        partials.push(await this.generateValidated({
          ...generation,
          prompt: debriefPrompt(
            transcript,
            previous !== null,
            transcriptChunks.length > 1,
          ),
        }));
      }
      const contentMd = partials.length === 1
        ? partials[0]!
        : await this.consolidateDebriefs(
            generation,
            partials,
            "SYNTHÈSES PARTIELLES",
          );
      const created = this.store.createWithReference({
        conversationId,
        eventIdFrom: candidates[0]!.id,
        eventIdTo: candidates.at(-1)!.id,
        contentMd,
      });
      this.broadcast(conversationId, created.event);
      return created.debrief;
    } finally {
      this.active.delete(conversationId);
    }
  }

  /** Le handoff réutilise la dernière version si aucun événement ne l'a périmée. */
  async latestOrGenerate(conversationId: string): Promise<Debrief> {
    try {
      return await this.activity.runExclusive(
        conversationId,
        "debrief",
        () => this.latestOrGenerateUnlocked(conversationId),
      );
    } catch (error) {
      if (error instanceof ConversationBusyError) {
        throw new DebriefAlreadyRunningError(error.message);
      }
      throw error;
    }
  }

  private async latestOrGenerateUnlocked(conversationId: string): Promise<Debrief> {
    try {
      return await this.generateUnlocked(conversationId);
    } catch (error) {
      if (!(error instanceof NoNewDebriefEventsError)) throw error;
      const latest = this.store.latest(conversationId);
      if (!latest) throw error;
      return latest;
    }
  }

  /** Garde la source verrouillée jusqu'à la fin de la création de la continuation. */
  async withHandoff<T>(
    conversationId: string,
    operation: (artifact: HandoffDebriefArtifact) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.activity.runExclusive(conversationId, "handoff", async () => {
        const latest = await this.latestOrGenerateUnlocked(conversationId);
        const versions = this.store.listByConversation(conversationId);
        let contentMd = versions.map((version, index) => [
          `# Débrief ${index + 1} — événements ${version.event_id_from} à ${version.event_id_to}`,
          "",
          version.content_md,
        ].join("\n")).join("\n\n---\n\n");
        if (contentMd.length > MAX_HANDOFF_CHARS) {
          const conversation = this.conversations.get(conversationId)!;
          const project = this.projects.get(conversation.project_id)!;
          const consolidated = await this.consolidateDebriefs(
            {
              cwd: project.path,
              provider: conversation.provider,
              model: conversation.model,
              effort: conversation.effort ?? undefined,
              speed: conversation.speed ?? undefined,
            },
            versions.map((version) => version.content_md),
            "HISTORIQUE DE DÉBRIEFS",
          );
          contentMd = `# Synthèse cumulative des débriefs\n\n${consolidated}`;
        }
        return operation({ latest, contentMd });
      });
    } catch (error) {
      if (error instanceof ConversationBusyError) {
        throw new DebriefAlreadyRunningError(error.message);
      }
      throw error;
    }
  }

  private async generateValidated(input: DebriefGenerationInput): Promise<string> {
    const content = (await this.generator(input)).trim();
    validateDebrief(content);
    if (content.length > MAX_GENERATED_DEBRIEF_CHARS) {
      throw new Error(`débrief trop long (${content.length} caractères)`);
    }
    return content;
  }

  private async consolidateDebriefs(
    generation: Omit<DebriefGenerationInput, "prompt">,
    debriefs: string[],
    label: string,
  ): Promise<string> {
    let current = debriefs;
    while (current.length > 1) {
      const groups = groupTexts(current, MAX_CONSOLIDATION_SOURCE_CHARS);
      const next: string[] = [];
      for (const group of groups) {
        next.push(await this.generateValidated({
          ...generation,
          prompt: consolidationPrompt(group.join("\n\n---\n\n"), label),
        }));
      }
      current = next;
    }
    return current[0]!;
  }
}

function clip(value: string): string {
  return value.length <= MAX_EVENT_CHARS
    ? value
    : `${value.slice(0, MAX_EVENT_CHARS)}\n[… événement tronqué …]`;
}

function transcriptFor(events: StoredEvent[]): string {
  const lines: string[] = [];
  for (const event of events) {
    const prefix = `[événement #${event.id}]`;
    switch (event.type) {
      case "user-message":
        lines.push(`${prefix} Utilisateur :\n${clip(event.text)}`);
        break;
      case "text-final":
        lines.push(`${prefix} Agent :\n${clip(event.text)}`);
        break;
      case "tool-start":
        lines.push(`${prefix} Outil ${event.toolName} appelé avec :\n${clip(JSON.stringify(event.input))}`);
        break;
      case "tool-end":
        lines.push(`${prefix} Résultat d'outil :\n${clip(event.output)}`);
        break;
      case "subtask-ref":
        lines.push(`${prefix} Sous-tâche « ${event.label ?? event.subtaskId} » déléguée à ${event.provider}/${event.model}.`);
        break;
      case "status":
        if (event.state === "error") lines.push(`${prefix} Erreur : ${event.error ?? "inconnue"}`);
        break;
      default:
        break;
    }
  }
  return lines.join("\n\n");
}

function transcriptChunksFor(events: StoredEvent[]): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const event of events) {
    const item = transcriptFor([event]);
    if (!item) continue;
    const candidate = current ? `${current}\n\n${item}` : item;
    if (candidate.length <= MAX_TRANSCRIPT_CHARS) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    current = item;
  }
  if (current) chunks.push(current);
  return chunks;
}

function groupTexts(values: string[], limit: number): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];
  let length = 0;
  for (const value of values) {
    const extra = value.length + (current.length > 0 ? 5 : 0);
    if (current.length > 0 && length + extra > limit) {
      groups.push(current);
      current = [];
      length = 0;
    }
    current.push(value);
    length += extra;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function debriefPrompt(
  transcript: string,
  incremental: boolean,
  partial = false,
): string {
  return [
    "Tu produis un débrief opérationnel en français pour un collègue qui doit reprendre le contrôle du travail.",
    partial
      ? "Le segment ci-dessous est une tranche d'une longue conversation : résume fidèlement cette tranche."
      : incremental
      ? "Le segment ci-dessous commence après le dernier débrief : résume uniquement ce qui a changé depuis."
      : "Le segment ci-dessous couvre la conversation depuis son début.",
    "Appuie chaque décision ou point important sur les identifiants [événement #N] fournis.",
    "N'invente rien, n'utilise aucun outil et retourne uniquement du Markdown avec exactement ces cinq titres :",
    "## Ce qui a été construit",
    "## Décisions et pourquoi",
    "## Alternatives écartées",
    "## Implications",
    "## Points ouverts",
    "",
    "SEGMENT À DÉBRIEFER",
    transcript,
  ].join("\n");
}

function validateDebrief(content: string): void {
  if (!content) throw new Error("débrief vide");
  for (const heading of [
    "## Ce qui a été construit",
    "## Décisions et pourquoi",
    "## Alternatives écartées",
    "## Implications",
    "## Points ouverts",
  ]) {
    if (!content.includes(heading)) throw new Error(`débrief invalide : section manquante « ${heading} »`);
  }
}

function consolidationPrompt(content: string, label: string): string {
  return [
    "Fusionne les débriefs suivants en un bilan cumulatif fidèle et concis.",
    "Conserve les références [événement #N], élimine seulement les répétitions et n'invente rien.",
    "Retourne uniquement du Markdown avec exactement ces cinq titres :",
    "## Ce qui a été construit",
    "## Décisions et pourquoi",
    "## Alternatives écartées",
    "## Implications",
    "## Points ouverts",
    "",
    label,
    content,
  ].join("\n");
}

async function generateWithAdapters(
  input: DebriefGenerationInput,
  quotas: QuotaTracker,
): Promise<string> {
  const parts: string[] = [];
  let final = "";
  let providerError: string | null = null;
  const emit = (event: AppEvent) => {
    quotas.ingest(event);
    if (event.type === "text-delta") parts.push(event.text);
    if (event.type === "text-final") final = event.text;
    if (event.type === "status" && event.state === "error") {
      providerError = event.error ?? "échec du modèle";
    }
  };
  const options = {
    cwd: input.cwd,
    provider: input.provider,
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
  return final || parts.join("");
}
