import type { Database } from "bun:sqlite";
import type { Provider } from "../events";

export const PRESET_PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "plan",
  "dontAsk",
  "bypassPermissions",
] as const;

export type PresetPermissionMode = typeof PRESET_PERMISSION_MODES[number];

/**
 * Les alias conviviaux restent acceptés à l'entrée de l'API. Le stockage garde
 * la valeur native de Claude Code pour ne pas casser les projets existants qui
 * utilisent déjà `permission_mode`.
 */
const PERMISSION_MODE_ALIASES: Readonly<Record<string, PresetPermissionMode>> = {
  yolo: "bypassPermissions",
  autonomous: "bypassPermissions",
  autonome: "bypassPermissions",
};

export function normalizePresetPermissionMode(
  value: unknown,
): PresetPermissionMode | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error("permission_mode invalide");
  const normalized = PERMISSION_MODE_ALIASES[value] ?? value;
  if (!(PRESET_PERMISSION_MODES as readonly string[]).includes(normalized)) {
    throw new Error("permission_mode invalide");
  }
  return normalized as PresetPermissionMode;
}

export interface PresetInput {
  name: string;
  provider: Provider;
  model: string;
  effort: string | null;
  speed: "standard" | "fast" | null;
  orchestrator: boolean;
  subagent_preset_id?: string | null;
  subagent_effort?: string | null;
  permission_mode?: PresetPermissionMode | null;
  review_provider?: Provider;
  review_model?: string;
  review_effort?: string;
}

export interface Preset extends Omit<PresetInput, "permission_mode" | "review_provider" | "review_model" | "review_effort"> {
  id: string;
  subagent_preset_id: string | null;
  subagent_effort: string | null;
  permission_mode: PresetPermissionMode | null;
  review_provider: Provider;
  review_model: string;
  review_effort: string;
  /**
   * Un preset livré avec Pupitre. Le drapeau n'interdit plus l'édition : il dit
   * seulement que le preset a des valeurs d'origine restaurables (`restore`) et
   * qu'il ne peut pas être supprimé — la liste garde toujours ses trois repères.
   */
  built_in: boolean;
  created_at: string;
  updated_at: string;
}

type BuiltInPreset = Omit<PresetInput, "permission_mode"> & {
  id: string;
  permission_mode: PresetPermissionMode | null;
  review_provider: Provider;
  review_model: string;
  review_effort: string;
};

const BUILT_INS: ReadonlyArray<BuiltInPreset> = [
  {
    id: "builtin-eco",
    name: "Éco",
    provider: "codex",
    model: "gpt-5.6-luna",
    effort: "low",
    speed: "standard",
    orchestrator: true,
    subagent_preset_id: null,
    subagent_effort: null,
    permission_mode: null,
    review_provider: "codex",
    review_model: "gpt-5.6-sol",
    review_effort: "high",
  },
  {
    id: "builtin-quality",
    name: "Qualité max",
    provider: "claude",
    model: "fable-5",
    effort: "max",
    speed: null,
    orchestrator: true,
    subagent_preset_id: null,
    subagent_effort: null,
    permission_mode: null,
    review_provider: "claude",
    review_model: "opus",
    review_effort: "high",
  },
  {
    id: "builtin-speed",
    name: "Vitesse",
    provider: "codex",
    model: "gpt-5.6-luna",
    effort: "low",
    speed: "fast",
    orchestrator: true,
    subagent_preset_id: null,
    subagent_effort: null,
    permission_mode: null,
    review_provider: "codex",
    review_model: "gpt-5.6-luna",
    review_effort: "low",
  },
];

export class PresetStore {
  constructor(private db: Database) {
    ensurePermissionModeColumn(this.db);
    const now = new Date().toISOString();
    const insert = this.db.query(`
      INSERT OR IGNORE INTO presets
        (id, name, provider, model, effort, speed, orchestrator,
         subagent_preset_id, subagent_effort,
         permission_mode, review_provider, review_model, review_effort,
         built_in, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `);
    for (const preset of BUILT_INS) {
      insert.run(
        preset.id,
        preset.name,
        preset.provider,
        preset.model,
        preset.effort,
        preset.speed,
        preset.orchestrator ? 1 : 0,
        preset.subagent_preset_id ?? null,
        preset.subagent_effort ?? null,
        preset.permission_mode,
        preset.review_provider,
        preset.review_model,
        preset.review_effort,
        now,
        now,
      );
      // Pas de réécriture au démarrage : les presets intégrés sont éditables,
      // un UPDATE inconditionnel écraserait le réglage de l'utilisateur à chaque
      // lancement. La bascule M2 → M3 de la config Gardien est déjà faite une
      // fois pour toutes par la migration de colonne (cf. db.ts).
    }
  }

  get(id: string): Preset | null {
    const row = this.db.query("SELECT * FROM presets WHERE id = ?").get(id) as any;
    return row ? this.hydrate(row) : null;
  }

  list(): Preset[] {
    const rows = this.db.query(`
      SELECT * FROM presets
      ORDER BY built_in DESC,
        CASE id
          WHEN 'builtin-eco' THEN 0
          WHEN 'builtin-quality' THEN 1
          WHEN 'builtin-speed' THEN 2
          ELSE 3
        END,
        created_at ASC, name COLLATE NOCASE ASC
    `).all() as any[];
    return rows.map((row) => this.hydrate(row));
  }

  create(input: PresetInput): Preset {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const review = reviewConfig(input, defaultReviewConfig(input.provider));
    const permissionMode = normalizePresetPermissionMode(input.permission_mode);
    this.db.query(`
      INSERT INTO presets
        (id, name, provider, model, effort, speed, orchestrator,
         subagent_preset_id, subagent_effort,
         permission_mode, review_provider, review_model, review_effort,
         built_in, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(
      id,
      input.name,
      input.provider,
      input.model,
      input.effort,
      input.speed,
      input.orchestrator ? 1 : 0,
      input.subagent_preset_id ?? null,
      input.subagent_effort ?? null,
      permissionMode,
      review.provider,
      review.model,
      review.effort,
      now,
      now,
    );
    return this.get(id)!;
  }

  update(id: string, input: PresetInput): Preset | null {
    const preset = this.get(id);
    if (!preset) return null;
    const subagentPresetId = input.subagent_preset_id === undefined
      ? preset.subagent_preset_id
      : input.subagent_preset_id;
    const subagentEffort = input.subagent_effort === undefined
      ? preset.subagent_effort
      : input.subagent_effort;
    const permissionMode = input.permission_mode === undefined
      ? preset.permission_mode
      : normalizePresetPermissionMode(input.permission_mode);
    const review = reviewConfig(input, id === "builtin-speed"
      ? { provider: input.provider, model: input.model, effort: input.effort }
      : {
          provider: preset.review_provider,
          model: preset.review_model,
          effort: preset.review_effort,
        });
    this.db.query(`
      UPDATE presets
      SET name = ?, provider = ?, model = ?, effort = ?, speed = ?,
          orchestrator = ?, subagent_preset_id = ?, subagent_effort = ?,
          permission_mode = ?, review_provider = ?, review_model = ?,
          review_effort = ?, updated_at = ?
      WHERE id = ?
    `).run(
      input.name,
      input.provider,
      input.model,
      input.effort,
      input.speed,
      input.orchestrator ? 1 : 0,
      subagentPresetId ?? null,
      subagentEffort ?? null,
      permissionMode,
      review.provider,
      review.model,
      review.effort,
      new Date().toISOString(),
      id,
    );
    return this.get(id);
  }

  /**
   * Remet un preset intégré à sa configuration d'origine. Le seul filet après
   * édition : sans lui, écraser « Éco » perdrait définitivement le repère.
   */
  restore(id: string): Preset | null {
    const original = BUILT_INS.find((preset) => preset.id === id);
    if (!original) {
      if (!this.get(id)) return null;
      throw new Error("preset sans valeurs d'origine");
    }
    this.db.query(`
      UPDATE presets
      SET name = ?, provider = ?, model = ?, effort = ?, speed = ?,
          orchestrator = ?, subagent_preset_id = ?, subagent_effort = ?,
          permission_mode = ?, review_provider = ?, review_model = ?,
          review_effort = ?, updated_at = ?
      WHERE id = ?
    `).run(
      original.name,
      original.provider,
      original.model,
      original.effort,
      original.speed,
      original.orchestrator ? 1 : 0,
      original.subagent_preset_id ?? null,
      original.subagent_effort ?? null,
      original.permission_mode,
      original.review_provider,
      original.review_model,
      original.review_effort,
      new Date().toISOString(),
      id,
    );
    return this.get(id);
  }

  delete(id: string): boolean {
    const preset = this.get(id);
    if (!preset) return false;
    if (preset.built_in) throw new Error("preset intégré non supprimable");
    const transaction = this.db.transaction(() => {
      this.db.query(
        `UPDATE projects
         SET default_preset_id = CASE WHEN default_preset_id = ? THEN NULL ELSE default_preset_id END,
             default_review_preset_id = CASE WHEN default_review_preset_id = ? THEN NULL ELSE default_review_preset_id END,
             default_correction_preset_id = CASE WHEN default_correction_preset_id = ? THEN NULL ELSE default_correction_preset_id END
         WHERE default_preset_id = ? OR default_review_preset_id = ? OR default_correction_preset_id = ?`,
      ).run(id, id, id, id, id, id);
      this.db.query("DELETE FROM presets WHERE id = ?").run(id);
    });
    transaction();
    return true;
  }

  private hydrate(row: any): Preset {
    return {
      ...row,
      orchestrator: !!row.orchestrator,
      built_in: !!row.built_in,
      permission_mode: normalizePresetPermissionMode(row.permission_mode),
    };
  }
}

/** La colonne appartient au store pour rester compatible avec les bases M2. */
function ensurePermissionModeColumn(db: Database): void {
  const columns = db.query("PRAGMA table_info(presets)").all() as Array<{ name?: string }>;
  if (columns.some((column) => column.name === "permission_mode")) return;
  db.exec("ALTER TABLE presets ADD COLUMN permission_mode TEXT NULL");
}

export interface ReviewModelConfig {
  provider: Provider;
  model: string;
  effort: string;
}

export function defaultReviewConfig(provider: Provider): ReviewModelConfig {
  return provider === "claude"
    ? { provider, model: "opus", effort: "high" }
    : { provider, model: "gpt-5.6-sol", effort: "high" };
}

function reviewConfig(input: PresetInput, fallback: ReviewModelConfig): ReviewModelConfig {
  const provider = input.review_provider ?? fallback.provider;
  const providerFallback = provider === fallback.provider
    ? fallback
    : defaultReviewConfig(provider);
  return {
    provider,
    model: input.review_model ?? providerFallback.model,
    effort: input.review_effort ?? providerFallback.effort,
  };
}
