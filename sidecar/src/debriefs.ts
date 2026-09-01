import { runProviderTurn } from "./adapters/run";
import type { AppEvent, Provider, StoredEvent } from "./events";
import type { QuotaTracker } from "./quotas";
import type { ConversationStore } from "./stores/conversations";
import type { Debrief, DebriefStore } from "./stores/debriefs";
import type { ProjectStore } from "./stores/projects";
import {
  ConversationActivity,
  ConversationBusyError,
} from "./conversation-activity";
import { conversationCwd } from "./workspace";

const MAX_TRANSCRIPT_CHARS = 180_000;
const MAX_EVENT_CHARS = 8_000;
const MAX_HANDOFF_CHARS = 120_000;
const MAX_GENERATED_DEBRIEF_CHARS = 32_000;
const MAX_CONSOLIDATION_SOURCE_CHARS = 100_000;
const MAX_GENERATED_SUMMARY_CHARS = 6_000;

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

export interface SessionSummary {
  id: string;
  conversation_id: string;
  event_id_from: number;
  event_id_to: number;
  content_md: string;
  created_at: string;
}

export type DebriefGenerator = (input: DebriefGenerationInput) => Promise<string>;

export class DebriefAlreadyRunningError extends Error {}
export class NoNewDebriefEventsError extends Error {}
export class NoNewSessionSummaryEventsError extends Error {}

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

  activeCount(): number {
    return this.active.size;
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

  async generateSessionSummary(conversationId: string): Promise<SessionSummary> {
    try {
      return await this.activity.runExclusive(
        conversationId,
        "session-summary",
        () => this.generateSessionSummaryUnlocked(conversationId),
      );
    } catch (error) {
      if (error instanceof ConversationBusyError) {
        throw new DebriefAlreadyRunningError(error.message);
      }
      throw error;
    }
  }

  latestSessionSummary(conversationId: string): SessionSummary | null {
    const event = [...this.conversations.listEvents(conversationId)].reverse()
      .find((item) => item.type === "session-summary-ref");
    if (!event || event.type !== "session-summary-ref") return null;
    return {
      id: event.summaryId,
      conversation_id: conversationId,
      event_id_from: event.eventIdFrom,
      event_id_to: event.eventIdTo,
      content_md: event.contentMd,
      created_at: event.createdAt,
    };
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
        cwd: conversationCwd(project, conversation),
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

  private async generateSessionSummaryUnlocked(conversationId: string): Promise<SessionSummary> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) throw new Error("conversation inconnue");
    const project = this.projects.get(conversation.project_id);
    if (!project) throw new Error("projet inconnu");

    const events = this.conversations.listEvents(conversationId);
    const previous = [...events]
      .reverse()
      .find((event) => event.type === "session-summary-ref");
    const candidates = events
      .filter((event) => event.id > (previous?.eventIdTo ?? 0))
      .filter((event) => event.type !== "debrief-ref")
      .filter((event) => event.type !== "session-summary-ref");
    const transcriptChunks = transcriptChunksFor(candidates);
    if (candidates.length === 0 || transcriptChunks.length === 0) {
      throw new NoNewSessionSummaryEventsError("aucun nouvel événement à résumer");
    }

    const generation = {
      cwd: conversationCwd(project, conversation),
      provider: "codex" as const,
      model: "gpt-5.6-luna",
      effort: "high",
      speed: "fast" as const,
    };
    const partials: string[] = [];
    for (const transcript of transcriptChunks) {
      partials.push(await this.generateSessionSummaryValidated({
        ...generation,
        prompt: sessionSummaryPrompt(
          transcript,
          previous !== undefined,
          transcriptChunks.length > 1,
        ),
      }));
    }
    const contentMd = partials.length === 1
      ? partials[0]!
      : await this.consolidateSessionSummaries(generation, partials);
    const createdAt = new Date().toISOString();
    const summaryId = crypto.randomUUID();
    const event: AppEvent = {
      type: "session-summary-ref",
      summaryId,
      eventIdFrom: candidates[0]!.id,
      eventIdTo: candidates.at(-1)!.id,
      contentMd,
      createdAt,
    };
    const eventId = this.conversations.appendEvent(conversationId, event);
    this.broadcast(conversationId, { ...event, id: eventId });
    return {
      id: summaryId,
      conversation_id: conversationId,
      event_id_from: event.eventIdFrom,
      event_id_to: event.eventIdTo,
      content_md: contentMd,
      created_at: createdAt,
    };
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
              cwd: conversationCwd(project, conversation),
              provider: conversation.provider,
              model: conversation.model,
              effort: conversation.effort ?? undefined,
              speed: conversation.speed ?? undefined,
            },
            versions.map((version) => version.content_md),
            "HISTORIQUE DE DÉBRIEFS",
            true,
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

  private async generateSessionSummaryValidated(input: DebriefGenerationInput): Promise<string> {
    const content = (await this.generator(input)).trim();
    validateSessionSummary(content);
    if (content.length > MAX_GENERATED_SUMMARY_CHARS) {
      throw new Error(`résumé de session trop long (${content.length} caractères)`);
    }
    return content;
  }

  private async consolidateSessionSummaries(
    generation: Omit<DebriefGenerationInput, "prompt">,
    summaries: string[],
  ): Promise<string> {
    // Même discipline que consolidateDebriefs : une très longue session peut
    // produire plus de partiels que la fenêtre du provider n'en accepte d'un
    // coup — on consolide par paliers bornés au lieu d'un join intégral.
    let current = summaries;
    while (current.length > 1) {
      const groups = groupTexts(current, MAX_CONSOLIDATION_SOURCE_CHARS);
      const next: string[] = [];
      for (const group of groups) {
        next.push(await this.generateSessionSummaryValidated({
          ...generation,
          prompt: sessionSummaryConsolidationPrompt(group.join("\n\n---\n\n")),
        }));
      }
      current = next;
    }
    return current[0]!;
  }

  private async consolidateDebriefs(
    generation: Omit<DebriefGenerationInput, "prompt">,
    debriefs: string[],
    label: string,
    forceFirstPass = false,
  ): Promise<string> {
    let current = debriefs;
    let mustConsolidate = forceFirstPass;
    while (current.length > 1 || mustConsolidate) {
      const groups = groupTexts(current, MAX_CONSOLIDATION_SOURCE_CHARS);
      const next: string[] = [];
      for (const group of groups) {
        next.push(await this.generateValidated({
          ...generation,
          prompt: consolidationPrompt(group.join("\n\n---\n\n"), label),
        }));
      }
      current = next;
      mustConsolidate = false;
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
    if (value.length > limit) {
      if (current.length > 0) {
        groups.push(current);
        current = [];
        length = 0;
      }
      for (let offset = 0; offset < value.length; offset += limit) {
        groups.push([value.slice(offset, offset + limit)]);
      }
      continue;
    }
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

function sessionSummaryPrompt(
  transcript: string,
  incremental: boolean,
  partial: boolean,
): string {
  return [
    "Tu produis un résumé de session très court pour un développeur.",
    partial
      ? "Le segment ci-dessous est une tranche d'une longue conversation : ne retiens que les changements concrets de cette tranche."
      : incremental
      ? "Résume uniquement les changements depuis le dernier résumé de session."
      : "Résume uniquement les changements concrets de cette session.",
    "Ne liste pas les appels d'outils, les détails de raisonnement ou les décisions sans effet pratique.",
    "N'invente aucun correctif, fichier, test ou TODO.",
    "Retourne uniquement du Markdown avec exactement le titre ## Implémenté et, uniquement s'il reste des éléments explicitement ouverts, le titre ## À terminer.",
    "Utilise 2 à 8 puces au total. Chaque puce doit être courte et actionnable. Cite [événement #N] seulement lorsque cela clarifie la preuve.",
    "",
    "SEGMENT À RÉSUMER",
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

function validateSessionSummary(content: string): void {
  if (!content) throw new Error("résumé de session vide");
  const lines = content.split("\n");
  const headings = lines.map((line) => line.trim()).filter((line) => line.startsWith("#"));
  if (!headings.includes("## Implémenté")) {
    throw new Error("résumé de session invalide : section manquante « Implémenté »");
  }
  // Le prompt impose exactement ces deux titres : tout autre titre signale un
  // résumé hors format qu'il ne faut pas épingler tel quel dans le fil.
  for (const heading of headings) {
    if (heading !== "## Implémenté" && heading !== "## À terminer") {
      throw new Error(`résumé de session invalide : titre interdit « ${heading} »`);
    }
  }
  const bullets = lines.filter((line) => /^\s*[-*] /.test(line));
  if (bullets.length === 0) {
    throw new Error("résumé de session invalide : aucune puce");
  }
  if (bullets.length > 8) {
    throw new Error(`résumé de session invalide : ${bullets.length} puces (maximum 8)`);
  }
}

function sessionSummaryConsolidationPrompt(content: string): string {
  return [
    "Fusionne les résumés de session suivants en un seul résumé très court.",
    "Élimine les répétitions, conserve uniquement les changements concrets et n'invente aucun élément.",
    "Retourne uniquement du Markdown avec les titres ## Implémenté et, seulement si nécessaire, ## À terminer.",
    "Limite-toi à 8 puces au total.",
    "",
    content,
  ].join("\n");
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

export async function generateWithAdapters(
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
  await runProviderTurn(input.provider, options, emit);
  if (providerError !== null) throw new Error(providerError);
  return final || parts.join("");
}
