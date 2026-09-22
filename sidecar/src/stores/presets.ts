import type { Database } from "bun:sqlite";
import type { Provider } from "../events";

export const PRESET_PERMISSION_MODES = ["plan", "acceptEdits", "dontAsk", "bypassPermissions"] as const;
export type PresetPermissionMode = typeof PRESET_PERMISSION_MODES[number];

const ALIASES: Readonly<Record<string, PresetPermissionMode>> = {
  yolo: "bypassPermissions", autonomous: "bypassPermissions",
  autonome: "bypassPermissions", default: "plan",
};

export function normalizePresetPermissionMode(value: unknown): PresetPermissionMode | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error("permission_mode invalide");
  const normalized = ALIASES[value] ?? value;
  if (!(PRESET_PERMISSION_MODES as readonly string[]).includes(normalized)) throw new Error("permission_mode invalide");
  return normalized as PresetPermissionMode;
}

export interface PresetInput {
  name: string;
  provider: Provider;
  model: string;
  effort: string | null;
  speed: "standard" | "fast" | null;
  permission_mode?: PresetPermissionMode | null;
}

export interface Preset extends PresetInput {
  id: string;
  permission_mode: PresetPermissionMode | null;
  built_in: boolean;
  created_at: string;
  updated_at: string;
}

type BuiltInPreset = PresetInput & { id: string };
const BUILT_INS: ReadonlyArray<BuiltInPreset> = [
  { id: "builtin-eco", name: "Éco", provider: "codex", model: "gpt-6-luna", effort: "low", speed: "standard", permission_mode: null },
  { id: "builtin-quality", name: "Qualité max", provider: "claude", model: "fable-5.1", effort: "max", speed: null, permission_mode: null },
  { id: "builtin-speed", name: "Vitesse", provider: "codex", model: "gpt-6-luna", effort: "low", speed: "fast", permission_mode: null },
];

export class PresetStore {
  constructor(private db: Database) {
    ensureColumn(db);
    const now = new Date().toISOString();
    const insert = db.query(
      "INSERT OR IGNORE INTO presets (id,name,provider,model,effort,speed,permission_mode,built_in,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,?,?)",
    );
    for (const preset of BUILT_INS) {
      insert.run(preset.id, preset.name, preset.provider, preset.model, preset.effort, preset.speed, preset.permission_mode ?? null, now, now);
    }
    for (const column of ["review_provider", "review_model", "review_effort", "review_explicit"]) dropColumn(db, column);
  }

  get(id: string): Preset | null {
    const row = this.db.query("SELECT * FROM presets WHERE id = ?").get(id) as any;
    return row ? hydrate(row) : null;
  }

  list(): Preset[] {
    const rows = this.db.query(
      "SELECT * FROM presets ORDER BY built_in DESC, CASE id WHEN 'builtin-eco' THEN 0 WHEN 'builtin-quality' THEN 1 WHEN 'builtin-speed' THEN 2 ELSE 3 END, created_at ASC, name COLLATE NOCASE ASC",
    ).all() as any[];
    return rows.map(hydrate);
  }

  create(input: PresetInput): Preset {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.query(
      "INSERT INTO presets (id,name,provider,model,effort,speed,permission_mode,built_in,created_at,updated_at) VALUES (?,?,?,?,?,?,?,0,?,?)",
    ).run(id, input.name, input.provider, input.model, input.effort, input.speed, normalizePresetPermissionMode(input.permission_mode), now, now);
    return this.get(id)!;
  }

  update(id: string, input: PresetInput): Preset | null {
    if (!this.get(id)) return null;
    this.db.query("UPDATE presets SET name=?,provider=?,model=?,effort=?,speed=?,permission_mode=?,updated_at=? WHERE id=?")
      .run(input.name, input.provider, input.model, input.effort, input.speed, normalizePresetPermissionMode(input.permission_mode), new Date().toISOString(), id);
    return this.get(id);
  }

  restore(id: string): Preset | null {
    const original = BUILT_INS.find((preset) => preset.id === id);
    if (!original) {
      if (!this.get(id)) return null;
      throw new Error("preset sans valeurs d'origine");
    }
    return this.update(id, original);
  }

  delete(id: string): boolean {
    const preset = this.get(id);
    if (!preset) return false;
    if (preset.built_in) throw new Error("preset intégré non supprimable");
    this.db.transaction(() => {
      this.db.query("UPDATE projects SET default_preset_id=CASE WHEN default_preset_id=? THEN NULL ELSE default_preset_id END, default_scout_preset_id=CASE WHEN default_scout_preset_id=? THEN NULL ELSE default_scout_preset_id END, default_todo_preset_id=CASE WHEN default_todo_preset_id=? THEN NULL ELSE default_todo_preset_id END WHERE default_preset_id=? OR default_scout_preset_id=? OR default_todo_preset_id=?")
        .run(id, id, id, id, id, id);
      this.db.query("DELETE FROM presets WHERE id = ?").run(id);
    })();
    return true;
  }
}

function hydrate(row: any): Preset {
  return { ...row, built_in: !!row.built_in, permission_mode: normalizePresetPermissionMode(row.permission_mode) };
}

function ensureColumn(db: Database): void {
  const columns = db.query("PRAGMA table_info(presets)").all() as Array<{ name?: string }>;
  if (!columns.some((column) => column.name === "permission_mode")) db.exec("ALTER TABLE presets ADD COLUMN permission_mode TEXT NULL");
}

function dropColumn(db: Database, column: string): void {
  const columns = db.query("PRAGMA table_info(presets)").all() as Array<{ name?: string }>;
  if (columns.some((item) => item.name === column)) db.exec(`ALTER TABLE presets DROP COLUMN ${column}`);
}
