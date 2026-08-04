import type { Database } from "bun:sqlite";
import type { AppEvent, StoredEvent } from "../events";

export interface Debrief {
  id: string;
  conversation_id: string;
  event_id_from: number;
  event_id_to: number;
  content_md: string;
  created_at: string;
}

export interface CreatedDebrief {
  debrief: Debrief;
  event: StoredEvent;
}

export class DebriefStore {
  constructor(private db: Database) {}

  get(id: string): Debrief | null {
    return this.db.query("SELECT * FROM debriefs WHERE id = ?").get(id) as Debrief | null;
  }

  latest(conversationId: string): Debrief | null {
    return this.db.query(`
      SELECT * FROM debriefs
      WHERE conversation_id = ?
      ORDER BY event_id_to DESC, created_at DESC, id DESC
      LIMIT 1
    `).get(conversationId) as Debrief | null;
  }

  listByConversation(conversationId: string): Debrief[] {
    return this.db.query(`
      SELECT * FROM debriefs
      WHERE conversation_id = ?
      ORDER BY event_id_to, created_at, id
    `).all(conversationId) as Debrief[];
  }

  /** Persiste la version et sa référence de fil dans une seule transaction. */
  createWithReference(input: {
    conversationId: string;
    eventIdFrom: number;
    eventIdTo: number;
    contentMd: string;
  }): CreatedDebrief {
    const create = this.db.transaction(() => {
      const debrief: Debrief = {
        id: crypto.randomUUID(),
        conversation_id: input.conversationId,
        event_id_from: input.eventIdFrom,
        event_id_to: input.eventIdTo,
        content_md: input.contentMd,
        created_at: new Date().toISOString(),
      };
      this.db.query(`
        INSERT INTO debriefs
          (id, conversation_id, event_id_from, event_id_to, content_md, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        debrief.id,
        debrief.conversation_id,
        debrief.event_id_from,
        debrief.event_id_to,
        debrief.content_md,
        debrief.created_at,
      );
      const reference: AppEvent = {
        type: "debrief-ref",
        debriefId: debrief.id,
        eventIdFrom: debrief.event_id_from,
        eventIdTo: debrief.event_id_to,
        contentMd: debrief.content_md,
        createdAt: debrief.created_at,
      };
      const result = this.db.query(`
        INSERT INTO events (conversation_id, payload, created_at) VALUES (?, ?, ?)
      `).run(input.conversationId, JSON.stringify(reference), debrief.created_at);
      this.db.query("UPDATE conversations SET updated_at = ? WHERE id = ?")
        .run(debrief.created_at, input.conversationId);
      return {
        debrief,
        event: { ...reference, id: Number(result.lastInsertRowid) },
      };
    });
    return create();
  }
}
