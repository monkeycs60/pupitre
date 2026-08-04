import type { Database } from "bun:sqlite";

export class SettingsStore {
  constructor(private db: Database) {}

  get<T = unknown>(key: string): T | null {
    const row = this.db.query("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string }
      | null;
    return row ? JSON.parse(row.value) as T : null;
  }

  set(key: string, value: unknown): void {
    this.db.query(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, JSON.stringify(value));
  }

  all(): Record<string, unknown> {
    const rows = this.db.query("SELECT key, value FROM settings ORDER BY key").all() as Array<{
      key: string;
      value: string;
    }>;
    return Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value)]));
  }
}
