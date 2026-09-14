import type { ConversationRunner } from "./runner";
import type { IntegrationsRefresher } from "./integrations/refresher";
import type { ConversationStore } from "./stores/conversations";
import type { ProjectStore } from "./stores/projects";
import type { SettingsStore } from "./stores/settings";
import type { Ticket, TicketRef, TicketStore } from "./stores/tickets";
import type { Database } from "bun:sqlite";

export interface TicketAuditConfig {
  provider: "codex" | "claude" | "grok";
  model: string;
  effort: string;
  speed: "standard" | "fast";
}

export const DEFAULT_TICKET_AUDIT_CONFIG: TicketAuditConfig = {
  provider: "codex",
  model: "gpt-5.6-sol",
  effort: "medium",
  speed: "standard",
};

export class TicketAuditService {
  constructor(
    private db: Database,
    private tickets: TicketStore,
    private conversations: ConversationStore,
    private projects: ProjectStore,
    private settings: SettingsStore,
    private refresher: IntegrationsRefresher,
    private runner: ConversationRunner,
  ) {}

  scan(projectId: string): void {
    for (const ticket of this.tickets.listActive(projectId)) {
      if (!this.shouldStart(ticket)) continue;
      const refs = this.tickets.refsByTicket(ticket.id);
      if (!refs.some((ref) => ref.kind === "mr")) continue;
      if (!this.reserve(ticket.id)) continue;
      void this.run(ticket, refs).catch((error) => this.fail(ticket.id, error));
    }
  }

  private shouldStart(ticket: Ticket): boolean {
    return ticket.source === "clickup"
      && ticket.payload.assignedToMe === true
      && normalizeStatus(ticket.status) === "code review"
      && normalizeStatus(ticket.payload.previousClickUpStatus) !== "code review";
  }

  private reserve(ticketId: string): boolean {
    const now = new Date().toISOString();
    return this.db.query(
      "INSERT OR IGNORE INTO ticket_audits (ticket_id,state,created_at,updated_at) VALUES (?, 'reserved', ?, ?)",
    ).run(ticketId, now, now).changes === 1;
  }

  private async run(ticket: Ticket, refs: TicketRef[]): Promise<void> {
    const project = this.projects.get(ticket.project_id);
    if (!project) throw new Error("projet introuvable");
    const context = await this.refresher.clickUpContext(ticket.project_id, ticket.key);
    const related = this.tickets.conversationsByTicket(ticket.id);
    const worktreePath = related.find((conversation) => conversation.worktree_path)?.worktree_path ?? null;
    const config = this.settings.get<TicketAuditConfig>("ticketAuditConfig") ?? DEFAULT_TICKET_AUDIT_CONFIG;
    const prompt = auditPrompt(ticket, refs, context, related);
    const conversation = this.conversations.create({
      projectId: ticket.project_id,
      ...config,
      permissionMode: "acceptEdits",
      worktreePath,
      ticketId: ticket.id,
      ticketInstruction: ticket.instruction,
      firstMessage: prompt,
    });
    this.conversations.rename(conversation.id, `Relecture ${ticket.key}`);
    this.db.query("UPDATE ticket_audits SET conversation_id=?,state='running',updated_at=? WHERE ticket_id=?")
      .run(conversation.id, new Date().toISOString(), ticket.id);
    const outcome = await this.runner.runTurn(conversation.id, prompt, []);
    if (outcome.state !== "done" || outcome.cancelled) throw new Error(outcome.error ?? "audit interrompu");
    this.db.query("UPDATE ticket_audits SET state='done',error=NULL,updated_at=? WHERE ticket_id=?")
      .run(new Date().toISOString(), ticket.id);
  }

  private fail(ticketId: string, error: unknown): void {
    this.db.query("UPDATE ticket_audits SET state='error',error=?,updated_at=? WHERE ticket_id=?")
      .run(error instanceof Error ? error.message : String(error), new Date().toISOString(), ticketId);
  }
}

function normalizeStatus(value: unknown): string {
  return typeof value === "string" ? value.trim().toLocaleLowerCase("fr") : "";
}

function auditPrompt(
  ticket: Ticket,
  refs: TicketRef[],
  context: Awaited<ReturnType<IntegrationsRefresher["clickUpContext"]>>,
  related: ReturnType<TicketStore["conversationsByTicket"]>,
): string {
  const mergeRequests = refs.filter((ref) => ref.kind === "mr").map((ref) => ({ ref: ref.ref, ...ref.payload }));
  const attachments = context?.attachments ?? [];
  return `Effectue l'audit final du ticket ${ticket.key}. Ne modifie aucun fichier et ne publie rien sur GitLab ou ClickUp pendant ce premier tour. Lis le diff final de chaque MR, dépôt par dépôt, puis rends une synthèse unique. Les dépôts sans MR ne sont pas relus, mais tu peux les consulter pour détecter un impact inter-dépôts.

Priorités, dans cet ordre : (1) conformité complète à la description, aux commentaires et pièces jointes du ticket ; transforme tout manque ou choix ambigu en question explicite, (2) design system Reactor : exécute le script on-verifie-le-design/audit-ui-diff.sh et utilise reactor-components-reference, sans prendre la maquette pour cible visuelle, (3) bugs, régressions, permissions et effets de bord de production, (4) impacts sur les autres dépôts, (5) code devenu mort à cause du ticket, (6) éléments grossiers : duplication massive, logs ou code commenté, logique critique sans test, (7) architecture seulement si impératif et strictement dans le périmètre. Ne relève pas le découpage de fonctions, le nommage, le style, les préférences ni les défauts mineurs. Chaque remarque doit valoir le temps de la lire. « Rien à signaler » est une excellente conclusion si aucune remarque utile n'existe.

Pièces jointes : lis les images, PDF et fichiers texte depuis leur URL. Pour tout format non pris en charge ou téléchargement impossible, indique explicitement la pièce illisible et n'invente pas son contenu.

Contexte ClickUp complet : ${JSON.stringify({ title: ticket.title, description: context?.description ?? "", comments: context?.comments ?? [], attachments })}
MR à relire : ${JSON.stringify(mergeRequests)}
Conversations liées (utilise leurs résumés et approfondis les fils utiles) : ${JSON.stringify(related.map((item) => ({ id: item.id, title: item.title, summary: item.summary })))}
Instruction propre au ticket : ${ticket.instruction || "aucune"}`;
}
