import type { Database } from "bun:sqlite";
import type { Provider } from "../events";

export interface PresetInput {
  name: string;
  provider: Provider;
  model: string;
  effort: string | null;
  speed: "standard" | "fast" | null;
  orchestrator: boolean;
  review_provider?: Provider;
  review_model?: string;
  review_effort?: string;
}

export interface Preset extends Omit<PresetInput, "review_provider" | "review_model" | "review_effort"> {
  id: string;
  review_provider: Provider;
  review_model: string;
  review_effort: string;
  built_in: boolean;
  created_at: string;
  updated_at: string;
}

const BUILT_INS: ReadonlyArray<PresetInput & {
  id: string;
  review_provider: Provider;
  review_model: string;
  review_effort: string;
}> = [
  {
    id: "builtin-eco",
    name: "Éco",
    provider: "codex",
    model: "gpt-5.6-luna",
    effort: "low",
    speed: "standard",
    orchestrator: true,
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
    review_provider: "codex",
    review_model: "gpt-5.6-sol",
    review_effort: "high",
  },
];

export class PresetStore {
  constructor(private db: Database) {
    const now = new Date().toISOString();
    const insert = this.db.query(`
      INSERT OR IGNORE INTO presets
        (id, name, provider, model, effort, speed, orchestrator,
         review_provider, review_model, review_effort, built_in, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
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
        preset.review_provider,
        preset.review_model,
        preset.review_effort,
        now,
        now,
      );
      // Les presets intégrés peuvent déjà exister dans une base M2 : leur
      // configuration Gardien doit tout de même recevoir les valeurs tranchées M3.
      this.db.query(`
        UPDATE presets
        SET review_provider = ?, review_model = ?, review_effort = ?
        WHERE id = ?
      `).run(
        preset.review_provider,
        preset.review_model,
        preset.review_effort,
        preset.id,
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
    const review = reviewConfig(input, defaultReviewConfig(input.provider));
    this.db.query(`
      INSERT INTO presets
        (id, name, provider, model, effort, speed, orchestrator,
         review_provider, review_model, review_effort, built_in, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(
      id,
      input.name,
      input.provider,
      input.model,
      input.effort,
      input.speed,
      input.orchestrator ? 1 : 0,
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
    if (preset.built_in) throw new Error("preset intégré immuable");
    const review = reviewConfig(input, {
      provider: preset.review_provider,
      model: preset.review_model,
      effort: preset.review_effort,
    });
    this.db.query(`
      UPDATE presets
      SET name = ?, provider = ?, model = ?, effort = ?, speed = ?,
          orchestrator = ?, review_provider = ?, review_model = ?,
          review_effort = ?, updated_at = ?
      WHERE id = ?
    `).run(
      input.name,
      input.provider,
      input.model,
      input.effort,
      input.speed,
      input.orchestrator ? 1 : 0,
      review.provider,
      review.model,
      review.effort,
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
