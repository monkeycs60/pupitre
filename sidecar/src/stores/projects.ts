import { trunkOf } from "../trunk";
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
  model: "gpt-6.1-sol",
  effort: "high",
  speed: "standard",
};

export const PROJECT_COLORS = [
  "#8b7cff", "#4f8cff", "#22b8cf", "#20c997", "#51cf66", "#fcc419",
  "#ff922b", "#ff6b6b", "#f06595", "#cc5de8", "#94a3b8", "#a9e34b",
] as const;

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const IMAGE_DATA_URL = /^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/;
export const MAX_PROJECT_ICON_BYTES = 512 * 1024;

/**
 * `auto` : logo trouvé dans le dépôt, sinon initiales. `custom` : image
 * envoyée par l'utilisateur, servie par `/api/projects/:id/icon`.
 */
export type ProjectIconMode = "auto" | "initials" | "custom";

export interface ProjectAppearanceInput {
  name?: string;
  color?: string;
  icon?: "auto" | "initials" | string;
  archived?: boolean;
}

export interface Project {
  id: string; name: string; path: string;
  trunk_branch?: string | null;
  detected_trunk?: string | null;
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
  color: string;
  icon: ProjectIconMode;
  archived_at: string | null;
  /** Change à chaque modification d'apparence : sert à invalider l'image en cache. */
  appearance_version: number;
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
    const model = parsed.provider === "claude" && (parsed.model === "opus" || parsed.model === "sonnet")
      ? `${parsed.model}-5.5`
      : parsed.model;
    return { provider: parsed.provider, model, effort: parsed.effort, speed: parsed.speed === "fast" ? "fast" : "standard" };
  } catch {
    return null;
  }
}

function iconMode(value: unknown): ProjectIconMode {
  if (typeof value === "string" && value.startsWith("data:")) return "custom";
  return value === "initials" ? "initials" : "auto";
}

function hashColor(id: string): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return PROJECT_COLORS[hash % PROJECT_COLORS.length]!;
}

function hydrate(row: any): Project {
  return {
    ...row,
    color: typeof row.color === "string" && HEX_COLOR.test(row.color) ? row.color : hashColor(row.id),
    icon: iconMode(row.icon),
    archived_at: row.archived_at ?? null,
    appearance_version: row.appearance_version ?? 0,
    detected_trunk: trunkOf(row.path, row.trunk_branch),
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
    const existing = this.db.query("SELECT id FROM projects WHERE path = ? AND removed_at IS NOT NULL").get(input.path) as { id: string } | null;
    if (existing) {
      this.db.query("UPDATE projects SET removed_at = NULL, name = ? WHERE id = ?").run(input.name, existing.id);
      return this.get(existing.id)!;
    }
    const id = crypto.randomUUID();
    this.db.query(
      "INSERT INTO projects (id, name, path, created_at, color) VALUES (?, ?, ?, ?, ?)"
    ).run(id, input.name, input.path, new Date().toISOString(), this.leastUsedColor());
    return this.get(id)!;
  }

  get(id: string): Project | null {
    const row = this.db.query("SELECT * FROM projects WHERE id = ? AND removed_at IS NULL").get(id) as any;
    return row ? hydrate(row) : null;
  }

  list(): Project[] {
    const rows = this.db.query(
      "SELECT * FROM projects WHERE removed_at IS NULL ORDER BY sort_order IS NULL, sort_order ASC, pinned DESC, created_at DESC"
    ).all() as any[];
    return rows.map(hydrate);
  }

  private leastUsedColor(): string {
    const rows = this.db.query("SELECT color FROM projects WHERE removed_at IS NULL").all() as { color: string | null }[];
    const usage = new Map<string, number>(PROJECT_COLORS.map((color) => [color, 0]));
    for (const row of rows) if (row.color && usage.has(row.color)) usage.set(row.color, usage.get(row.color)! + 1);
    let best: string = PROJECT_COLORS[0];
    for (const [color, count] of usage) if (count < usage.get(best)!) best = color;
    return best;
  }

  /** Lève une `Error` dont le message est destiné à l'utilisateur. */
  updateAppearance(id: string, input: ProjectAppearanceInput): void {
    const sets: string[] = [];
    const values: (string | null)[] = [];
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name || name.length > 80) throw new Error("nom de projet invalide");
      sets.push("name = ?"); values.push(name);
    }
    if (input.color !== undefined) {
      if (!HEX_COLOR.test(input.color)) throw new Error("couleur invalide");
      sets.push("color = ?"); values.push(input.color.toLowerCase());
    }
    if (input.icon !== undefined) {
      const icon = input.icon;
      if (icon !== "auto" && icon !== "initials" && !IMAGE_DATA_URL.test(icon)) throw new Error("icône invalide");
      if (icon.length > MAX_PROJECT_ICON_BYTES) throw new Error("image trop lourde");
      sets.push("icon = ?"); values.push(icon === "auto" ? null : icon);
    }
    if (input.archived !== undefined) {
      sets.push("archived_at = ?"); values.push(input.archived ? new Date().toISOString() : null);
    }
    if (!sets.length) return;
    sets.push("appearance_version = COALESCE(appearance_version, 0) + 1");
    this.db.query(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
  }

  /** Image personnalisée du projet, telle qu'enregistrée. */
  customIcon(id: string): { mimeType: string; bytes: Buffer } | null {
    const row = this.db.query("SELECT icon FROM projects WHERE id = ? AND removed_at IS NULL").get(id) as { icon: string | null } | null;
    const match = row?.icon?.match(/^data:([^;]+);base64,(.+)$/);
    return match ? { mimeType: match[1]!, bytes: Buffer.from(match[2]!, "base64") } : null;
  }

  remove(id: string): void {
    this.db.query("UPDATE projects SET removed_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  }

  reorder(ids: string[]): void {
    const projects = this.list();
    if (new Set(ids).size !== ids.length || ids.length !== projects.length || projects.some((project) => !ids.includes(project.id))) throw new Error("ordre invalide");
    this.db.transaction(() => {
      ids.forEach((id, index) => this.db.query("UPDATE projects SET sort_order = ? WHERE id = ?").run(index, id));
    })();
  }

  setTrunkBranch(id: string, branch: string | null): void {
    this.db.query("UPDATE projects SET trunk_branch = ? WHERE id = ?").run(branch, id);
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
