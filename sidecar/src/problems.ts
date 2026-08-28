import type { DebriefGenerator } from "./debriefs";
import {
  type ProblemCapture,
  type ProblemDraft,
  ProblemStore,
} from "./stores/problems";
import type { ProjectStore } from "./stores/projects";
import type { Ticket, TicketStore } from "./stores/tickets";
import { projectCwd } from "./workspace";
export { problemIdsInCommit } from "./problem-id";

export const MAX_CAPTURE_CHARS = 50_000;
export const MAX_PROBLEMS_PER_CAPTURE = 20;
export const MAX_PROBLEM_PLANS = 5;

const PUBLIC_ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export class ProblemService {
  private tail = Promise.resolve();
  private listeners = new Set<(projectId: string) => void>();

  constructor(
    private store: ProblemStore,
    private projects: ProjectStore,
    private tickets: TicketStore,
    private generator: DebriefGenerator,
    onChange?: (projectId: string) => void,
  ) {
    if (onChange) this.listeners.add(onChange);
  }

  subscribe(listener: (projectId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  capture(projectId: string, rawText: string): ProblemCapture {
    if (!this.projects.get(projectId)) throw new Error("projet inconnu");
    const text = rawText.trim();
    if (!text) throw new Error("texte vide");
    if (text.length > MAX_CAPTURE_CHARS) {
      throw new Error("le texte dépasse la limite de 50 000 caractères");
    }
    const capture = this.store.createCapture(projectId, text);
    this.changed(projectId);
    return capture;
  }

  processCapture(captureId: string): Promise<void> {
    const task = this.tail.then(() => this.runCapture(captureId));
    this.tail = task.catch(() => {});
    return task;
  }

  retry(captureId: string): ProblemCapture {
    const capture = this.store.queueAgain(captureId);
    if (!capture || capture.status !== "queued") throw new Error("capture non relançable");
    this.changed(capture.project_id);
    void this.processCapture(capture.id);
    return capture;
  }

  async resume(): Promise<void> {
    const pending = this.store.recoverCaptures();
    await Promise.all(pending.map((capture) => this.processCapture(capture.id)));
  }

  closeFromCommit(projectId: string, message: string, sha: string): number {
    const closed = this.store.closeFromCommit(projectId, message, sha);
    if (closed > 0) this.changed(projectId);
    return closed;
  }

  private async runCapture(captureId: string): Promise<void> {
    const capture = this.store.markProcessing(captureId);
    if (!capture) return;
    this.changed(capture.project_id);
    try {
      const project = this.projects.get(capture.project_id);
      if (!project) throw new Error("projet inconnu");
      const tickets = this.tickets.listActive(project.id);
      const raw = await this.generator({
        cwd: projectCwd(project),
        provider: "codex",
        model: "gpt-5.6-luna",
        effort: "medium",
        speed: "fast",
        prompt: problemPrompt(project.name, capture.raw_text, tickets),
      });
      const reserved = new Set<string>();
      const drafts = parseProblemDrafts(raw, tickets, () => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const candidate = problemPublicId();
          if (reserved.has(candidate) || this.store.getByPublicId(candidate)) continue;
          reserved.add(candidate);
          return candidate;
        }
        throw new Error("impossible de créer un ID de problématique unique");
      });
      this.store.completeCapture(capture.id, drafts);
    } catch (error) {
      this.store.markError(
        capture.id,
        error instanceof Error ? error.message : "traitement de la capture impossible",
      );
    } finally {
      this.changed(capture.project_id);
    }
  }

  private changed(projectId: string): void {
    for (const listener of this.listeners) listener(projectId);
  }
}

export function problemPublicId(random: () => number = Math.random): string {
  let value = "PB-";
  for (let index = 0; index < 6; index += 1) {
    value += PUBLIC_ID_ALPHABET[Math.floor(random() * PUBLIC_ID_ALPHABET.length)] ?? "0";
  }
  return value;
}

export function parseProblemDrafts(
  raw: string,
  tickets: Ticket[],
  nextPublicId: () => string = problemPublicId,
): ProblemDraft[] {
  const match = raw.trim().match(/\[[\s\S]*\]/);
  if (!match) throw new Error("réponse Luna sans tableau JSON");
  const parsed = JSON.parse(match[0]) as unknown;
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > MAX_PROBLEMS_PER_CAPTURE) {
    throw new Error("la réponse doit contenir entre 1 et 20 problématiques");
  }
  const ticketsByKey = new Map(tickets.map((ticket) => [ticket.key.toUpperCase(), ticket]));
  return parsed.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("problématique invalide");
    }
    const item = value as Record<string, unknown>;
    if (!Array.isArray(item.conversations)
      || item.conversations.length < 1
      || item.conversations.length > MAX_PROBLEM_PLANS) {
      throw new Error("une problématique doit proposer entre 1 et 5 conversations");
    }
    const ticketKey = item.ticketKey === null || item.ticketKey === undefined
      ? null
      : String(item.ticketKey).trim().toUpperCase();
    return {
      publicId: nextPublicId(),
      title: boundedText(item.title, "titre", 120),
      context: boundedText(item.context, "contexte", 4_000),
      resolution: boundedText(item.resolution, "résolution", 4_000),
      ticketId: ticketKey ? ticketsByKey.get(ticketKey)?.id ?? null : null,
      plans: item.conversations.map((plan) => {
        if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
          throw new Error("proposition de conversation invalide");
        }
        const fields = plan as Record<string, unknown>;
        return {
          title: boundedText(fields.title, "titre de conversation", 120),
          instruction: boundedText(fields.instruction, "consigne de conversation", 4_000),
        };
      }),
    };
  });
}

function boundedText(value: unknown, label: string, max: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${label} manquant`);
  if (text.length > max) throw new Error(`${label} limité à ${max} caractères`);
  return text;
}

function problemPrompt(projectName: string, rawText: string, tickets: Ticket[]): string {
  return [
    "Tu structures une capture de travail brute en problématiques actionnables.",
    "Découpe les sujets sans les fusionner. Retourne uniquement un tableau JSON de 1 à 20 objets.",
    "Chaque objet suit exactement ce format :",
    '{"title":"...","context":"...","resolution":"...","ticketKey":"TECH-1"|null,"conversations":[{"title":"...","instruction":"..."}]}',
    "Propose entre 1 et 5 conversations autonomes. N'invente jamais une clé de ticket.",
    `PROJET: ${projectName}`,
    `TICKETS: ${JSON.stringify(tickets.map((ticket) => ({
      key: ticket.key,
      title: ticket.title,
      status: ticket.status,
    })))}`,
    `CAPTURE: ${rawText}`,
  ].join("\n\n");
}
