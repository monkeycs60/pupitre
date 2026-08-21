import type { Database } from "bun:sqlite";

export class IntegrationSecretStore {
  constructor(private readonly db: Database) {}

  get(integrationId: string, name: string): string | null {
    const row = this.db.query("SELECT value FROM integration_secrets WHERE integration_id = ? AND name = ?")
      .get(integrationId, name) as { value: string } | null;
    return row?.value ?? null;
  }

  set(integrationId: string, name: string, value: string): void {
    this.db.query(`INSERT INTO integration_secrets (integration_id,name,value,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(integration_id,name) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
      .run(integrationId, name, value, new Date().toISOString());
  }

  remove(integrationId: string, name: string): boolean {
    return this.db.query("DELETE FROM integration_secrets WHERE integration_id=? AND name=?").run(integrationId, name).changes === 1;
  }

  removeIntegration(integrationId: string): number {
    return this.db.query("DELETE FROM integration_secrets WHERE integration_id=?").run(integrationId).changes;
  }
}
