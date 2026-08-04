import type { Database } from "bun:sqlite";
import type { AppEvent, Provider } from "../events";

export interface Conversation {
  id: string; project_id: string; title: string; provider: Provider;
  model: string; effort: string | null; cli_session_id: string | null; pinned: boolean;
  created_at: string; updated_at: string;
}

const TITLE_MAX = 47;

export class ConversationStore {
  constructor(private db: Database) {}

  create(input: {
    projectId: string;
    provider: Provider;
    model: string;
    effort?: string | null;
    firstMessage: string;
  }): Conversation {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const title = input.firstMessage.length > TITLE_MAX
      ? input.firstMessage.slice(0, TITLE_MAX) + "…"
      : input.firstMessage;
    this.db.query(
      `INSERT INTO conversations
         (id, project_id, title, provider, model, effort, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.projectId,
      title,
      input.provider,
      input.model,
      input.effort ?? null,
      now,
      now,
    );
    return this.get(id)!;
  }

  get(id: string): Conversation | null {
    const row = this.db.query("SELECT * FROM conversations WHERE id = ?").get(id) as any;
    return row ? { ...row, pinned: !!row.pinned } : null;
  }

  listByProject(projectId: string): Conversation[] {
    const rows = this.db.query(
      "SELECT * FROM conversations WHERE project_id = ? ORDER BY pinned DESC, updated_at DESC"
    ).all(projectId) as any[];
    return rows.map((r) => ({ ...r, pinned: !!r.pinned }));
  }

  setPinned(id: string, pinned: boolean): void {
    this.db.query("UPDATE conversations SET pinned = ? WHERE id = ?").run(pinned ? 1 : 0, id);
  }

  setCliSessionId(id: string, cliSessionId: string): void {
    this.db.query("UPDATE conversations SET cli_session_id = ?, updated_at = ? WHERE id = ?")
      .run(cliSessionId, new Date().toISOString(), id);
  }

  appendEvent(conversationId: string, event: AppEvent): void {
    this.db.query("INSERT INTO events (conversation_id, payload, created_at) VALUES (?, ?, ?)")
      .run(conversationId, JSON.stringify(event), new Date().toISOString());
    this.db.query("UPDATE conversations SET updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), conversationId);
  }

  listEvents(conversationId: string): AppEvent[] {
    const rows = this.db.query(
      "SELECT payload FROM events WHERE conversation_id = ? ORDER BY id"
    ).all(conversationId) as any[];
    const events: AppEvent[] = [];
    for (const row of rows) {
      try {
        events.push(JSON.parse(row.payload));
      } catch (error) {
        console.error("Événement de conversation corrompu, ligne ignorée", error);
      }
    }
    return events;
  }
}
