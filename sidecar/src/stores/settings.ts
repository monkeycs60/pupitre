import type { Database } from "bun:sqlite";

/**
 * Repères de migration écrits par `openDb` dans la même table que les réglages
 * utilisateur. Ils ne font pas partie du contrat exposé par `all()`, que le
 * serveur sérialise tel quel dans sa réponse HTTP.
 */
export const MESSAGE_COUNT_MIGRATION_KEY = "conversation-message-count-v2";
export const SPEED_REVIEW_MIGRATION_KEY = "speed-review-follows-preset-v1";
export const CUSTOM_REVIEW_MIGRATION_KEY = "custom-review-follows-preset-v1";

const INTERNAL_KEYS = new Set([
  MESSAGE_COUNT_MIGRATION_KEY,
  SPEED_REVIEW_MIGRATION_KEY,
  CUSTOM_REVIEW_MIGRATION_KEY,
]);

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
    return Object.fromEntries(rows
      .filter((row) => !INTERNAL_KEYS.has(row.key))
      .map((row) => [row.key, JSON.parse(row.value)]));
  }
}
