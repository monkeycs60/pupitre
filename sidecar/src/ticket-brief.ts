import type { Ticket, TicketNote, TicketRef, TicketSource } from "./stores/tickets";

export const MAX_BRIEF_CHARS = 12_000;
const MAX_DEBRIEF_CHARS = 3_000;
const MAX_DESCRIPTION_CHARS = 2_000;
const MAX_COMMENT_CHARS = 400;

export interface TicketBriefInput {
  ticket: Pick<Ticket, "key" | "title" | "status" | "source" | "external_url">;
  branches: string[];
  refs: Array<Pick<TicketRef, "kind" | "ref" | "payload">>;
  notes: Array<Pick<TicketNote, "body" | "created_at">>;
  clickup: {
    description: string;
    comments: Array<{ author: string; text: string; at: string }>;
  } | null;
  siblings: Array<{
    id: string;
    title: string;
    summary: string;
    debrief: string | null;
  }>;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[tronqué]`;
}

function ticketSourceLabel(source: TicketSource): string {
  if (source === "clickup") return "ClickUp";
  if (source === "notion") return "Notion";
  return "Git";
}

export function composeTicketBrief(input: TicketBriefInput): string {
  const parts: string[] = [`# Reprise du ticket ${input.ticket.key}`, ""];

  parts.push(
    "## Ticket",
    `- Source : ${ticketSourceLabel(input.ticket.source)}`,
    `- Titre : ${input.ticket.title}`,
    `- Statut : ${input.ticket.status || "inconnu"}`,
  );
  if (input.ticket.external_url) {
    parts.push(`- Lien : ${input.ticket.external_url}`);
  }
  if (input.clickup?.description.trim()) {
    parts.push("", clip(input.clickup.description.trim(), MAX_DESCRIPTION_CHARS));
  }
  if (input.clickup?.comments.length) {
    parts.push("", "Derniers commentaires :");
    for (const comment of input.clickup.comments) {
      parts.push(
        `- ${comment.author} (${comment.at.slice(0, 10)}) : ${clip(comment.text.trim(), MAX_COMMENT_CHARS)}`,
      );
    }
  }

  parts.push("", "## Branche et MR");
  parts.push(
    input.branches.length > 0
      ? `- Branche : ${input.branches.join(", ")}`
      : "- Aucune branche connue",
  );
  for (const ref of input.refs) {
    if (ref.kind === "mr") {
      parts.push(
        `- MR ${ref.ref} : ${String(ref.payload.state ?? "")} · ${String(ref.payload.mergeStatus ?? "")} · ${String(ref.payload.url ?? "")}`,
      );
      continue;
    }
    if (ref.kind === "pipeline") {
      parts.push(
        `- Pipeline ${ref.ref} : ${String(ref.payload.status ?? "")} · ${String(ref.payload.url ?? "")}`,
      );
      continue;
    }
    if (ref.kind === "deployment") {
      parts.push(
        `- Déployé sur ${String(ref.payload.environment ?? ref.ref)} par ${String(ref.payload.user ?? "?")} le ${String(ref.payload.deployedAt ?? "").slice(0, 10)}`,
      );
    }
  }

  if (input.notes.length) {
    parts.push("", "## Notes");
    for (const note of input.notes) {
      parts.push(`- (${note.created_at.slice(0, 10)}) ${note.body}`);
    }
  }

  if (input.siblings.length) {
    parts.push("", "## Conversations précédentes sur ce ticket");
    for (const sibling of input.siblings) {
      parts.push(`### ${sibling.title} (id ${sibling.id})`, sibling.summary);
      if (sibling.debrief) {
        parts.push("", clip(sibling.debrief.trim(), MAX_DEBRIEF_CHARS));
      }
      parts.push("");
    }
  }

  parts.push(
    "## Consigne",
    "Prends ce contexte comme point de départ. Pour creuser une conversation précédente, appelle l'outil",
    "`read_sibling_conversation` avec son id plutôt que de deviner. Confirme brièvement la reprise, puis traite la demande ci-dessous.",
  );

  return clip(parts.join("\n"), MAX_BRIEF_CHARS);
}
