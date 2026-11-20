import type { Database } from "bun:sqlite";

export type NoteAuthor = "user" | "agent";
export type NoteScope = "ticket" | "project";

export const NOTE_MAX_CHARS = 500;

export interface Note {
  id: string;
  project_id: string;
  ticket_id: string | null;
  body: string;
  author: NoteAuthor;
  conversation_id: string | null;
  done_at: string | null;
  created_at: string;
}

export interface NoteInput {
  projectId: string;
  ticketId: string | null;
  body: string;
  author: NoteAuthor;
  conversationId: string | null;
}

export function isNoteAuthor(value: unknown): value is NoteAuthor {
  return value === "user" || value === "agent";
}

export function isNoteScope(value: unknown): value is NoteScope {
  return value === "ticket" || value === "project";
}

export class NoteStore {
  constructor(private readonly db: Database) {}

  get(id: string): Note | null {
    return this.db.query("SELECT * FROM notes WHERE id = ?").get(id) as Note | null;
  }

  create(input: NoteInput): Note {
    const id = crypto.randomUUID();
    this.db.query(`
      INSERT INTO notes (id, project_id, ticket_id, body, author, conversation_id, done_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
    `).run(
      id,
      input.projectId,
      input.ticketId,
      input.body,
      input.author,
      input.conversationId,
      new Date().toISOString(),
    );
    return this.get(id)!;
  }

  /** Notes du projet (sans ticket) et, si fourni, celles du ticket. */
  listFor(projectId: string, ticketId: string | null): Note[] {
    return this.db.query(`
      SELECT * FROM notes
      WHERE project_id = ? AND (ticket_id IS NULL OR ticket_id = ?)
      ORDER BY created_at, rowid
    `).all(projectId, ticketId) as Note[];
  }

  update(id: string, changes: { body?: string; done?: boolean }): Note | null {
    const existing = this.get(id);
    if (!existing) return null;
    const body = changes.body ?? existing.body;
    const doneAt = changes.done === undefined
      ? existing.done_at
      : changes.done ? existing.done_at ?? new Date().toISOString() : null;
    this.db.query("UPDATE notes SET body = ?, done_at = ? WHERE id = ?").run(body, doneAt, id);
    return this.get(id);
  }

  delete(id: string): Note | null {
    const existing = this.get(id);
    if (!existing) return null;
    this.db.query("DELETE FROM notes WHERE id = ?").run(id);
    return existing;
  }
}

/**
 * Bloc ajouté au premier tour d'une conversation : une puce par note ouverte
 * de son ticket ou de son projet, avec l'id attendu par `complete_note`.
 */
export function openNotesPreamble(notes: Note[], ticketKey: string | null): string | null {
  const open = notes.filter((note) => note.done_at === null);
  if (open.length === 0) return null;
  return [
    "## Notes ouvertes avant déploiement",
    "Points à ne pas oublier avant un merge ou une mise en prod. Quand l'un d'eux est réglé, appelle l'outil `complete_note` avec son id.",
    ...open.map((note) => {
      const scope = note.ticket_id === null ? "Projet" : ticketKey ? `Ticket ${ticketKey}` : "Ticket";
      return `- ${scope} · ${note.body.replace(/\s+/g, " ").trim()} (id ${note.id})`;
    }),
  ].join("\n");
}
