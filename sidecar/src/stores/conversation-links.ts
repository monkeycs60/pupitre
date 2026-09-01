import type { Database } from "bun:sqlite";

export interface ConversationLink {
  id: string;
  kind: "sidequest";
  source_conversation_id: string;
  source_event_id: number | null;
  target_conversation_id: string;
  label: string;
  created_at: string;
}

export class ConversationLinkStore {
  constructor(private readonly db: Database) {}

  createSidequest(input: {
    sourceConversationId: string;
    sourceEventId?: number | null;
    targetConversationId: string;
    label: string;
  }): ConversationLink {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.query(`
      INSERT INTO conversation_links
        (id, kind, source_conversation_id, source_event_id, target_conversation_id, label, created_at)
      VALUES (?, 'sidequest', ?, ?, ?, ?, ?)
    `).run(id, input.sourceConversationId, input.sourceEventId ?? null, input.targetConversationId, input.label.slice(0, 160), now);
    return this.byTarget(input.targetConversationId)!;
  }

  byTarget(conversationId: string): ConversationLink | null {
    return this.db.query("SELECT * FROM conversation_links WHERE target_conversation_id = ?")
      .get(conversationId) as ConversationLink | null;
  }

  fromSource(conversationId: string): ConversationLink[] {
    return this.db.query("SELECT * FROM conversation_links WHERE source_conversation_id = ? ORDER BY created_at DESC")
      .all(conversationId) as ConversationLink[];
  }
}
