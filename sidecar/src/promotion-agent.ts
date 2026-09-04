import { resolve } from "node:path";
import type { StoredEvent } from "./events";
import type { Conversation } from "./stores/conversations";
import type { Project } from "./stores/projects";

export const PROMOTION_SUCCESS_MARKER = "PROMOTION_VERIFIED";

export type PromotionMissionState = "running" | "waiting_user" | "succeeded" | "failed";

export interface PromotionMission {
  conversationId: string;
  projectId: string;
  state: PromotionMissionState;
  startedAt: string;
  finishedAt: string | null;
}

interface PromotionConversationStore {
  create(input: {
    projectId: string;
    provider: "codex";
    model: string;
    effort: string;
    speed: "standard";
    permissionMode: "bypassPermissions";
    orchestrator: false;
    worktreePath: null;
    createdOnBranch: string | null;
    originType: "promotion";
    originKey: string;
    firstMessage: string;
  }): Conversation;
  latestByOrigin(originType: "promotion", originKey: string): Conversation | null;
  listEvents(conversationId: string): StoredEvent[];
}

interface PromotionProjectStore {
  list(): Project[];
}

interface PromotionConversationRunner {
  isRunning(conversationId: string): boolean;
  runTurn(conversationId: string, message: string, images: [], attachments: []): Promise<unknown>;
}

export class PromotionAgentConflictError extends Error {}
export class PromotionAgentProjectError extends Error {}

export function promotionAgentPrompt(): string {
  return `# Mission prioritaire — promouvoir Pupitre en one-shot

Ton objectif terminal est de rendre l'état courant de ce dépôt effectivement fonctionnel dans l'instance stable de Pupitre. Cette mission est très importante : réalise-la de façon autonome en un seul lancement et ne rends pas la main au premier incident.

## Autorisations explicites

- Inspecte tout l'état courant, y compris les fichiers non suivis.
- Committe automatiquement toutes les modifications présentes avec un message cohérent.
- Exécute les tests pertinents, corrige les erreurs, recommitte et recommence autant que nécessaire.
- Lance la promotion avec \`bun run promote\` depuis ce dépôt.
- Tu peux utiliser un rollback temporaire pour garder la stable disponible, mais un rollback n'est jamais une réussite.

## Garde-fous

- Tu travailles dans le dépôt principal courant : ne crée ni branche ni worktree et ne change pas de branche.
- Ne pousse aucun commit distant.
- Ne tue jamais l'instance dev ni son sidecar sur le port 4821 : ils portent cette conversation. Le port 4820 appartient à la stable.
- Préserve les données utilisateur et n'utilise aucune commande Git destructive.
- Ne conclus jamais sur le seul succès du build ou de /api/health. Vérifie le SHA stable, le chargement du frontend, la restauration d'un projet lorsqu'il en existe, les processus et les journaux après redémarrage.
- Si un problème technique survient, diagnostique-le et répare-le toi-même. Ne demande à l'utilisateur que si une décision produit ambiguë, une autorisation extérieure ou un blocage matériel rend toute progression sûre impossible.

## Condition de fin

Quand, et seulement quand, la version finale est committée, promue et vérifiée dans la stable, termine ton bilan par une ligne contenant exactement :

${PROMOTION_SUCCESS_MARKER}

Commence maintenant et poursuis jusqu'au résultat.`;
}

function finalText(events: StoredEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "text-final") return event.text;
  }
  return null;
}

function lastStatus(events: StoredEvent[]): Extract<StoredEvent, { type: "status" }> | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "status") return event;
  }
  return null;
}

export class PromotionAgentService {
  private readonly originKey: string;

  constructor(
    private readonly root: string,
    private readonly projects: PromotionProjectStore,
    private readonly conversations: PromotionConversationStore,
    private readonly runner: PromotionConversationRunner,
  ) {
    this.originKey = resolve(root);
  }

  snapshot(): PromotionMission | null {
    const conversation = this.conversations.latestByOrigin("promotion", this.originKey);
    if (!conversation) return null;
    const events = this.conversations.listEvents(conversation.id);
    const status = lastStatus(events);
    const text = finalText(events);
    const running = this.runner.isRunning(conversation.id) || status?.state === "running";
    const succeeded = !running && text?.includes(PROMOTION_SUCCESS_MARKER) === true;
    const failed = !running && !succeeded && status?.state === "error";
    return {
      conversationId: conversation.id,
      projectId: conversation.project_id,
      state: running ? "running" : succeeded ? "succeeded" : failed ? "failed" : "waiting_user",
      startedAt: conversation.created_at,
      finishedAt: succeeded || failed ? conversation.updated_at : null,
    };
  }

  start(): PromotionMission {
    const current = this.snapshot();
    if (current?.state === "running" || current?.state === "waiting_user") {
      throw new PromotionAgentConflictError("une mission de promotion est déjà active");
    }
    const project = this.projects.list().find((candidate) => resolve(candidate.path) === this.originKey);
    if (!project) {
      throw new PromotionAgentProjectError("le dépôt Pupitre courant doit être enregistré comme projet");
    }
    const prompt = promotionAgentPrompt();
    const conversation = this.conversations.create({
      projectId: project.id,
      provider: "codex",
      model: "gpt-5.6-luna",
      effort: "high",
      speed: "standard",
      permissionMode: "bypassPermissions",
      orchestrator: false,
      worktreePath: null,
      createdOnBranch: null,
      originType: "promotion",
      originKey: this.originKey,
      firstMessage: prompt,
    });
    void this.runner.runTurn(conversation.id, prompt, [], [])
      .catch((error) => console.error("Échec de l'agent de promotion", error));
    return this.snapshot()!;
  }
}
