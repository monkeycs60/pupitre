import type { Database } from "bun:sqlite";
import type { Provider } from "../events";

export interface PresetInput {
  name: string;
  provider: Provider;
  model: string;
  effort: string | null;
  speed: "standard" | "fast" | null;
  orchestrator: boolean;
}

export interface Preset extends PresetInput {
  id: string;
  built_in: boolean;
  created_at: string;
  updated_at: string;
}

const BUILT_INS: ReadonlyArray<PresetInput & { id: string }> = [
  {
    id: "builtin-eco",
    name: "Éco",
    provider: "codex",
    model: "gpt-5.6-luna",
    effort: "low",
    speed: "standard",
    orchestrator: true,
  },
  {
    id: "builtin-quality",
    name: "Qualité max",
    provider: "claude",
    model: "fable-5",
    effort: "max",
    speed: null,
    orchestrator: true,
  },
  {
    id: "builtin-speed",
    name: "Vitesse",
    provider: "codex",
    model: "gpt-5.6-luna",
    effort: "low",
    speed: "fast",
    orchestrator: true,
  },
];

export class PresetStore {
  constructor(private db: Database) {
    const now = new Date().toISOString();
    const insert = this.db.query(`
      INSERT OR IGNORE INTO presets
        (id, name, provider, model, effort, speed, orchestrator, built_in, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
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
        now,
        now,
      );
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
    this.db.query(`
      INSERT INTO presets
        (id, name, provider, model, effort, speed, orchestrator, built_in, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(
      id,
      input.name,
      input.provider,
      input.model,
      input.effort,
      input.speed,
      input.orchestrator ? 1 : 0,
      now,
      now,
    );
    return this.get(id)!;
  }

  update(id: string, input: PresetInput): Preset | null {
    const preset = this.get(id);
    if (!preset) return null;
    if (preset.built_in) throw new Error("preset intégré immuable");
    this.db.query(`
      UPDATE presets
      SET name = ?, provider = ?, model = ?, effort = ?, speed = ?,
          orchestrator = ?, updated_at = ?
      WHERE id = ?
    `).run(
      input.name,
      input.provider,
      input.model,
      input.effort,
      input.speed,
      input.orchestrator ? 1 : 0,
      new Date().toISOString(),
      id,
    );
    return this.get(id);
  }

  delete(id: string): boolean {
    const preset = this.get(id);
    if (!preset) return false;
    if (preset.built_in) throw new Error("preset intégré immuable");
    const transaction = this.db.transaction(() => {
      this.db.query("UPDATE projects SET default_preset_id = NULL WHERE default_preset_id = ?").run(id);
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
    };
  }
}
