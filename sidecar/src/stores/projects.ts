import type { Database } from "bun:sqlite";
import { normalizeFilesystemScope, type FilesystemScope } from "../access";

export interface Project {
  id: string; name: string; path: string;
  permission_mode: string; pinned: boolean; created_at: string;
  default_preset_id: string | null;
  filesystem_scope: FilesystemScope;
  auto_counter_red: boolean;
  auto_rescan: boolean;
  /**
   * Serveurs MCP autorisés pour ce projet, par nom. `null` = aucun filtre, on
   * garde le comportement natif du CLI (tous les serveurs configurés). Une
   * liste, même vide, active le filtrage strict.
   */
  mcp_servers: string[] | null;
}

/** Colonne stockée en JSON : une valeur illisible vaut « aucun filtre ». */
function parseMcpServers(value: unknown): string[] | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((n) => typeof n === "string") : null;
  } catch {
    return null;
  }
}

export class ProjectStore {
  constructor(private db: Database) {}

  create(input: { name: string; path: string }): Project {
    const id = crypto.randomUUID();
    this.db.query(
      "INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)"
    ).run(id, input.name, input.path, new Date().toISOString());
    return this.get(id)!;
  }

  get(id: string): Project | null {
    const row = this.db.query("SELECT * FROM projects WHERE id = ?").get(id) as any;
    return row
      ? {
        ...row,
        pinned: !!row.pinned,
        auto_counter_red: !!row.auto_counter_red,
        auto_rescan: !!row.auto_rescan,
        filesystem_scope: normalizeFilesystemScope(row.filesystem_scope),
        mcp_servers: parseMcpServers(row.mcp_servers),
      }
      : null;
  }

  list(): Project[] {
    const rows = this.db.query(
      "SELECT * FROM projects ORDER BY pinned DESC, created_at DESC"
    ).all() as any[];
    return rows.map((r) => ({
      ...r,
      pinned: !!r.pinned,
      auto_counter_red: !!r.auto_counter_red,
      auto_rescan: !!r.auto_rescan,
      filesystem_scope: normalizeFilesystemScope(r.filesystem_scope),
      mcp_servers: parseMcpServers(r.mcp_servers),
    }));
  }

  setPinned(id: string, pinned: boolean): void {
    this.db.query("UPDATE projects SET pinned = ? WHERE id = ?").run(pinned ? 1 : 0, id);
  }

  setDefaultPreset(id: string, presetId: string | null): void {
    this.db.query("UPDATE projects SET default_preset_id = ? WHERE id = ?").run(presetId, id);
  }

  /** Applique une permission explicite portée par le preset par défaut. */
  setPermissionMode(id: string, mode: string): void {
    this.db.query("UPDATE projects SET permission_mode = ? WHERE id = ?").run(mode, id);
  }

  setFilesystemScope(id: string, scope: FilesystemScope): void {
    this.db.query("UPDATE projects SET filesystem_scope = ? WHERE id = ?")
      .run(scope, id);
  }

  /** `null` restaure le comportement natif : tous les serveurs configurés. */
  setMcpServers(id: string, servers: string[] | null): void {
    this.db.query("UPDATE projects SET mcp_servers = ? WHERE id = ?")
      .run(servers === null ? null : JSON.stringify(servers), id);
  }

  setAutoCounterRed(id: string, enabled: boolean): void {
    this.db.query("UPDATE projects SET auto_counter_red = ? WHERE id = ?")
      .run(enabled ? 1 : 0, id);
  }

  setAutoRescan(id: string, enabled: boolean): void {
    this.db.query("UPDATE projects SET auto_rescan = ? WHERE id = ?")
      .run(enabled ? 1 : 0, id);
  }
}
