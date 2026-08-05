import type { Database } from "bun:sqlite";

export interface AppNotification {
  id: number;
  kind: "routine" | "long-task";
  title: string;
  body: string;
  conversation_id: string | null;
  created_at: string;
}

export class NotificationStore {
  constructor(private readonly db: Database) {}

  create(input: Omit<AppNotification, "id" | "created_at">): AppNotification {
    const createdAt = new Date().toISOString();
    const result = this.db.query(`
      INSERT INTO app_notifications (kind, title, body, conversation_id, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(input.kind, input.title, input.body, input.conversation_id, createdAt);
    return this.db.query("SELECT * FROM app_notifications WHERE id = ?")
      .get(Number(result.lastInsertRowid)) as AppNotification;
  }

  listAfter(id: number): AppNotification[] {
    return this.db.query(`
      SELECT * FROM app_notifications WHERE id > ? ORDER BY id LIMIT 100
    `).all(id) as AppNotification[];
  }
}
