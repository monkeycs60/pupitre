import type { Database } from "bun:sqlite";
import { normalizeFilesystemScope, type FilesystemScope } from "../access";
import type { PresetPermissionMode } from "./presets";
import type { Provider } from "../events";

export interface ProjectLaunchConfig {
  provider: Provider;
  model: string;
  effort: string;
  speed: "standard" | "fast";
}

export type ProjectLaunchSlot = "default" | "scout" | "todo";

export const PROJECT_LAUNCH_SLOTS: readonly ProjectLaunchSlot[] = ["default", "scout", "todo"];

export const FALLBACK_PROJECT_LAUNCH_CONFIG: ProjectLaunchConfig = {
  provider: "codex",
  model: "gpt-6-sol",
  effort: "high",
  speed: "standard",
};

export interface Project {
  id: string; name: string; path: string;
  permission_mode: PresetPermissionMode; pinned: boolean; created_at: string;
  default_preset_id: string | null;
  default_scout_preset_id: string | null;
  /**
   * Preset appliqué aux nouvelles TODO. `null` = suivre `default_preset_id`,
   * le défaut conversationnel du projet.
   */
  default_todo_preset_id: string | null;
  /** Réglage des nouvelles conversations ; `null` = réglage du provider. */
  default_launch_config: ProjectLaunchConfig | null;
  /** Réglage des Scouts Sentry ; `null` = suivre `default_launch_config`. */
  scout_launch_config: ProjectLaunchConfig | null;
  /** Réglage des TODO lancées par Pupitre ; `null` = suivre `default_launch_config`. */
  todo_launch_config: ProjectLaunchConfig | null;
  filesystem_scope: FilesystemScope;
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

function parseLaunchConfig(value: unknown): ProjectLaunchConfig | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed?.provider !== "string" || typeof parsed.model !== "string" || typeof parsed.effort !== "string") return null;
    return { provider: parsed.provider, model: parsed.model, effort: parsed.effort, speed: parsed.speed === "fast" ? "fast" : "standard" };
  } catch {
    return null;
  }
}

function hydrate(row: any): Project {
  return {
    ...row,
    pinned: !!row.pinned,
    auto_rescan: !!row.auto_rescan,
    filesystem_scope: normalizeFilesystemScope(row.filesystem_scope),
    mcp_servers: parseMcpServers(row.mcp_servers),
    default_launch_config: parseLaunchConfig(row.default_launch_config),
    scout_launch_config: parseLaunchConfig(row.scout_launch_config),
    todo_launch_config: parseLaunchConfig(row.todo_launch_config),
  };
}

/** Réglage effectif d'un usage du projet, replié sur le défaut du projet puis sur Pupitre. */
export function projectLaunchConfig(project: Project, slot: ProjectLaunchSlot): ProjectLaunchConfig {
  const own = slot === "scout" ? project.scout_launch_config : slot === "todo" ? project.todo_launch_config : null;
  return own ?? project.default_launch_config ?? FALLBACK_PROJECT_LAUNCH_CONFIG;
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
    return row ? hydrate(row) : null;
  }

  list(): Project[] {
    const rows = this.db.query(
      "SELECT * FROM projects ORDER BY pinned DESC, created_at DESC"
    ).all() as any[];
    return rows.map(hydrate);
  }

  setPinned(id: string, pinned: boolean): void {
    this.db.query("UPDATE projects SET pinned = ? WHERE id = ?").run(pinned ? 1 : 0, id);
  }

  setLaunchConfig(id: string, slot: ProjectLaunchSlot, config: ProjectLaunchConfig | null): void {
    this.db.query(`UPDATE projects SET ${slot}_launch_config = ? WHERE id = ?`)
      .run(config === null ? null : JSON.stringify(config), id);
  }

  setPermissionMode(id: string, mode: PresetPermissionMode): void {
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

  setAutoRescan(id: string, enabled: boolean): void {
    this.db.query("UPDATE projects SET auto_rescan = ? WHERE id = ?")
      .run(enabled ? 1 : 0, id);
  }
}
