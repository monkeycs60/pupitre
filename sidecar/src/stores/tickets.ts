import type { Database } from "bun:sqlite";

export type TicketSource = "clickup" | "notion" | "git";
export type TicketRefKind = "branch" | "mr" | "pipeline" | "deployment" | "sentry_issue";

export interface Ticket {
  id: string;
  project_id: string;
  key: string;
  source: TicketSource;
  title: string;
  status: string;
  external_url: string | null;
  payload: Record<string, unknown>;
  last_seen_at: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TicketRef {
  id: string;
  ticket_id: string;
  kind: TicketRefKind;
  ref: string;
  payload: Record<string, unknown>;
  seen_at: string;
}

export interface TicketNote {
  id: string;
  ticket_id: string;
  body: string;
  created_at: string;
}

export interface TicketConversationSummary {
  id: string;
  title: string;
  summary: string;
  provider: string;
  updated_at: string;
  worktree_path: string | null;
}

export interface TicketRow extends Ticket {
  refs: TicketRef[];
  conversations: TicketConversationSummary[];
  notes_count: number;
}

export interface TicketInput {
  key: string;
  source: TicketSource;
  title: string;
  status: string;
  externalUrl: string | null;
  payload?: Record<string, unknown>;
}

const SOURCE_RANK: Record<TicketSource, number> = {
  git: 0,
  notion: 1,
  clickup: 1,
};

export const STALE_TICKET_DAYS = 14;

export class TicketStore {
  constructor(private db: Database) {}

  get(id: string): Ticket | null {
    const row = this.db.query("SELECT * FROM tickets WHERE id = ?").get(id) as Record<string, unknown> | null;
    return row ? hydrateTicket(row) : null;
  }

  findByKey(projectId: string, key: string): Ticket | null {
    const row = this.db.query(
      "SELECT * FROM tickets WHERE project_id = ? AND key = ?",
    ).get(projectId, key) as Record<string, unknown> | null;
    return row ? hydrateTicket(row) : null;
  }

  upsert(projectId: string, input: TicketInput): Ticket {
    const now = new Date().toISOString();
    const existing = this.findByKey(projectId, input.key);

    if (!existing) {
      const id = crypto.randomUUID();
      this.db.query(`
        INSERT INTO tickets (
          id, project_id, key, source, title, status, external_url, payload_json,
          last_seen_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        projectId,
        input.key,
        input.source,
        input.title,
        input.status,
        input.externalUrl,
        JSON.stringify(input.payload ?? {}),
        now,
        now,
        now,
      );
      return this.get(id)!;
    }

    if (SOURCE_RANK[input.source] >= SOURCE_RANK[existing.source]) {
      this.db.query(`
        UPDATE tickets
           SET source = ?,
               title = ?,
               status = ?,
               external_url = ?,
               payload_json = ?,
               last_seen_at = ?,
               archived_at = NULL,
               updated_at = ?
         WHERE id = ?
      `).run(
        input.source,
        input.title,
        input.status,
        input.externalUrl,
        JSON.stringify(input.payload ?? {}),
        now,
        now,
        existing.id,
      );
    } else {
      this.db.query(`
        UPDATE tickets
           SET last_seen_at = ?,
               archived_at = NULL,
               updated_at = ?
         WHERE id = ?
      `).run(now, now, existing.id);
    }

    return this.get(existing.id)!;
  }

  touchSeen(id: string, at = new Date().toISOString()): void {
    this.db.query(
      "UPDATE tickets SET last_seen_at = ?, archived_at = NULL, updated_at = ? WHERE id = ?",
    ).run(at, at, id);
  }

  archiveStale(projectId: string, now: Date = new Date()): number {
    const archivedAt = now.toISOString();
    const cutoff = new Date(now.getTime() - STALE_TICKET_DAYS * 86_400_000).toISOString();
    return this.db.query(`
      UPDATE tickets
         SET archived_at = ?,
             updated_at = ?
       WHERE project_id = ?
         AND archived_at IS NULL
         AND last_seen_at <= ?
    `).run(archivedAt, archivedAt, projectId, cutoff).changes;
  }

  upsertRef(ticketId: string, input: { kind: TicketRefKind; ref: string; payload: Record<string, unknown> }): TicketRef {
    const now = new Date().toISOString();
    this.db.query(`
      INSERT INTO ticket_refs (id, ticket_id, kind, ref, payload_json, seen_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(ticket_id, kind, ref)
      DO UPDATE SET payload_json = excluded.payload_json, seen_at = excluded.seen_at
    `).run(
      crypto.randomUUID(),
      ticketId,
      input.kind,
      input.ref,
      JSON.stringify(input.payload),
      now,
    );
    const row = this.db.query(
      "SELECT * FROM ticket_refs WHERE ticket_id = ? AND kind = ? AND ref = ?",
    ).get(ticketId, input.kind, input.ref) as Record<string, unknown> | null;
    if (!row) {
      throw new Error("référence introuvable après upsert");
    }
    return hydrateRef(row);
  }

  refsByTicket(ticketId: string): TicketRef[] {
    const rows = this.db.query(
      "SELECT * FROM ticket_refs WHERE ticket_id = ? ORDER BY kind, seen_at DESC",
    ).all(ticketId) as Record<string, unknown>[];
    return rows.map(hydrateRef);
  }

  branchesOf(ticketId: string): string[] {
    return this.refsByTicket(ticketId)
      .filter((ref) => ref.kind === "branch")
      .map((ref) => ref.ref);
  }

  addNote(ticketId: string, body: string): TicketNote {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.query(
      "INSERT INTO ticket_notes (id, ticket_id, body, created_at) VALUES (?, ?, ?, ?)",
    ).run(id, ticketId, body, now);
    return { id, ticket_id: ticketId, body, created_at: now };
  }

  notesByTicket(ticketId: string): TicketNote[] {
    return this.db.query(
      "SELECT * FROM ticket_notes WHERE ticket_id = ? ORDER BY created_at",
    ).all(ticketId) as TicketNote[];
  }

  deleteNote(id: string): boolean {
    return this.db.query("DELETE FROM ticket_notes WHERE id = ?").run(id).changes > 0;
  }

  linkConversation(conversationId: string, ticketId: string | null): void {
    this.db.query(
      "UPDATE conversations SET ticket_id = ? WHERE id = ?",
    ).run(ticketId, conversationId);
  }

  conversationsByTicket(ticketId: string): TicketConversationSummary[] {
    return this.db.query(`
      SELECT id, title, summary, provider, updated_at, worktree_path
      FROM conversations
      WHERE ticket_id = ?
        AND deleted_at IS NULL
      ORDER BY updated_at DESC
    `).all(ticketId) as TicketConversationSummary[];
  }

  listByProject(projectId: string): TicketRow[] {
    const rows = this.db.query(
      "SELECT * FROM tickets WHERE project_id = ? AND archived_at IS NULL ORDER BY updated_at DESC",
    ).all(projectId) as Record<string, unknown>[];
    return rows.map((row) => {
      const ticket = hydrateTicket(row);
      const notes = this.db.query(
        "SELECT COUNT(*) AS n FROM ticket_notes WHERE ticket_id = ?",
      ).get(ticket.id) as { n: number };
      return {
        ...ticket,
        refs: this.refsByTicket(ticket.id),
        conversations: this.conversationsByTicket(ticket.id),
        notes_count: notes.n,
      };
    });
  }
}

function hydrateTicket(row: Record<string, unknown>): Ticket {
  const { payload_json, ...rest } = row;
  return {
    ...rest,
    id: String(rest.id),
    project_id: String(rest.project_id),
    key: String(rest.key),
    source: rest.source as TicketSource,
    title: String(rest.title),
    status: String(rest.status ?? ""),
    external_url: (rest.external_url as string | null | undefined) ?? null,
    payload: JSON.parse(String(payload_json ?? "{}")) as Record<string, unknown>,
    last_seen_at: String(rest.last_seen_at ?? ""),
    archived_at: (rest.archived_at as string | null | undefined) ?? null,
    created_at: String(rest.created_at),
    updated_at: String(rest.updated_at),
  };
}

function hydrateRef(row: Record<string, unknown>): TicketRef {
  return {
    id: String(row.id),
    ticket_id: String(row.ticket_id),
    kind: row.kind as TicketRefKind,
    ref: String(row.ref),
    payload: JSON.parse(String(row.payload_json ?? "{}")) as Record<string, unknown>,
    seen_at: String(row.seen_at),
  };
}
