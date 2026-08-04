import { runClaudeTurn } from "./adapters/claude";
import { runCodexTurn } from "./adapters/codex";
import { runCodexAppServerTurn } from "./adapters/codex-app-server";
import type { AppEvent, Provider, StoredEvent } from "./events";
import type { QuotaTracker } from "./quotas";
import type { ConversationStore } from "./stores/conversations";
import type { Debrief, DebriefStore } from "./stores/debriefs";
import type { ProjectStore } from "./stores/projects";

const MAX_TRANSCRIPT_CHARS = 180_000;
const MAX_EVENT_CHARS = 8_000;

type BroadcastFn = (conversationId: string, event: StoredEvent) => void;

export interface DebriefGenerationInput {
  cwd: string;
  provider: Provider;
  model: string;
  effort?: string;
  speed?: "standard" | "fast";
  prompt: string;
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
    if (this.active.has(conversationId)) {
      throw new DebriefAlreadyRunningError("un débrief est déjà en cours");
    }
    const conversation = this.conversations.get(conversationId);
    if (!conversation) throw new Error("conversation inconnue");
    const project = this.projects.get(conversation.project_id);
    if (!project) throw new Error("projet inconnu");

    const previous = this.store.latest(conversationId);
    const candidates = this.conversations.listEvents(conversationId)
      .filter((event) => event.id > (previous?.event_id_to ?? 0))
      .filter((event) => event.type !== "debrief-ref");
    const transcript = transcriptFor(candidates);
    if (candidates.length === 0 || transcript.trim() === "") {
      throw new NoNewDebriefEventsError("aucun nouvel événement à débriefer");
    }
    if (transcript.length > MAX_TRANSCRIPT_CHARS) {
      throw new Error(
        `segment trop volumineux pour un débrief (${transcript.length} caractères)`,
      );
    }

    this.active.add(conversationId);
    try {
      const contentMd = (await this.generator({
        cwd: project.path,
        provider: conversation.provider,
        model: conversation.model,
        effort: conversation.effort ?? undefined,
        speed: conversation.speed ?? undefined,
        prompt: debriefPrompt(transcript, previous !== null),
      })).trim();
      validateDebrief(contentMd);
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

function debriefPrompt(transcript: string, incremental: boolean): string {
  return [
    "Tu produis un débrief opérationnel en français pour un collègue qui doit reprendre le contrôle du travail.",
    incremental
      ? "Le segment ci-dessous commence après le dernier débrief : résume uniquement ce qui a changé depuis."
      : "Le segment ci-dessous couvre la conversation depuis son début.",
    "Appuie chaque décision ou point important sur les identifiants [événement #N] fournis.",
    "N'invente rien, n'utilise aucun outil et retourne uniquement du Markdown avec exactement ces quatre titres :",
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
    "## Décisions et pourquoi",
    "## Alternatives écartées",
    "## Implications",
    "## Points ouverts",
  ]) {
    if (!content.includes(heading)) throw new Error(`débrief invalide : section manquante « ${heading} »`);
  }
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
