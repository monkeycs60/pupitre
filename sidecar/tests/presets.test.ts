import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { PresetStore } from "../src/stores/presets";
import { ProjectStore } from "../src/stores/projects";

let presets: PresetStore;
let projects: ProjectStore;

beforeEach(() => {
  const db = openDb(mkdtempSync(join(tmpdir(), "pupitre-presets-")));
  presets = new PresetStore(db);
  projects = new ProjectStore(db);
});

test("seed les trois presets M2 une seule fois", () => {
  expect(presets.list().map((preset) => preset.name)).toEqual([
    "Éco",
    "Qualité max",
    "Vitesse",
  ]);
  expect(presets.list().every((preset) => preset.built_in)).toBe(true);
  expect(presets.get("builtin-quality")).toMatchObject({
    review_provider: "claude",
    review_model: "opus",
    review_effort: "high",
  });
  expect(presets.get("builtin-eco")).toMatchObject({
    review_provider: "codex",
    review_model: "gpt-5.6-sol",
    review_effort: "high",
  });
  expect(presets.get("builtin-speed")).toMatchObject({
    review_provider: "codex",
    review_model: "gpt-5.6-luna",
    review_effort: "low",
  });
});

test("le preset Vitesse garde Gardien aligné après personnalisation", () => {
  expect(presets.update("builtin-speed", {
    name: "Vitesse",
    provider: "codex",
    model: "gpt-5.6-luna",
    effort: "xhigh",
    speed: "fast",
    orchestrator: true,
  })).toMatchObject({
    review_provider: "codex",
    review_model: "gpt-5.6-luna",
    review_effort: "xhigh",
  });
});

test("migre une seule fois l'ancienne review Sol du preset Vitesse", () => {
  const dir = mkdtempSync(join(tmpdir(), "pupitre-presets-speed-migration-"));
  const legacyDb = openDb(dir);
  const legacyPresets = new PresetStore(legacyDb);
  legacyDb.query(`
    UPDATE presets
    SET effort = 'xhigh', review_model = 'gpt-5.6-sol', review_effort = 'high'
    WHERE id = 'builtin-speed'
  `).run();
  legacyDb.query("DELETE FROM settings WHERE key = 'speed-review-follows-preset-v1'").run();
  legacyDb.close();

  const migratedDb = openDb(dir);
  expect(new PresetStore(migratedDb).get("builtin-speed")).toMatchObject({
    model: "gpt-5.6-luna",
    effort: "xhigh",
    review_model: "gpt-5.6-luna",
    review_effort: "xhigh",
  });
});

test("CRUD d'un preset personnalisé", () => {
  const created = presets.create({
    name: "Revue Codex",
    provider: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
    speed: "standard",
    orchestrator: true,
  });
  expect(created).toMatchObject({ name: "Revue Codex", built_in: false });
  expect(created).toMatchObject({
    review_provider: "codex",
    review_model: "gpt-5.6-sol",
    review_effort: "high",
  });

  const updated = presets.update(created.id, {
    name: "Revue rapide",
    provider: "codex",
    model: "gpt-5.6-luna",
    effort: "medium",
    speed: "fast",
    orchestrator: false,
  });
  expect(updated).toMatchObject({ name: "Revue rapide", speed: "fast" });
  expect(presets.delete(created.id)).toBe(true);
  expect(presets.get(created.id)).toBeNull();
});

test("un preset personnalisé utilise sa configuration pour la review", () => {
  const created = presets.create({
    name: "Sol medium",
    provider: "codex",
    model: "gpt-5.6-sol",
    effort: "medium",
    speed: "standard",
    orchestrator: true,
  });
  expect(created).toMatchObject({
    review_provider: "codex",
    review_model: "gpt-5.6-sol",
    review_effort: "medium",
  });
});

test("une review héritée suit le nouveau modèle, une review choisie ne bouge pas", () => {
  const inherited = presets.create({
    name: "Hérité",
    provider: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
    speed: "standard",
    orchestrator: true,
  });
  expect(inherited.review_explicit).toBe(false);
  expect(presets.update(inherited.id, {
    name: "Hérité",
    provider: "claude",
    model: "opus",
    effort: "medium",
    speed: "standard",
    orchestrator: true,
  })).toMatchObject({
    review_provider: "claude",
    review_model: "opus",
    review_effort: "medium",
  });

  const chosen = presets.create({
    name: "Relecteur choisi",
    provider: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
    speed: "standard",
    orchestrator: true,
    review_provider: "claude",
    review_model: "opus",
    review_effort: "high",
  });
  expect(chosen.review_explicit).toBe(true);
  expect(presets.update(chosen.id, {
    name: "Relecteur choisi",
    provider: "codex",
    model: "gpt-5.6-luna",
    effort: "low",
    speed: "fast",
    orchestrator: true,
  })).toMatchObject({
    review_provider: "claude",
    review_model: "opus",
    review_effort: "high",
  });
});

test("aligne la review des presets personnalisés d'une base sans colonne de review", () => {
  const dir = mkdtempSync(join(tmpdir(), "pupitre-presets-custom-review-migration-"));
  const legacyDb = openDb(dir);
  new PresetStore(legacyDb);
  legacyDb.query(`
    INSERT INTO presets
      (id, name, provider, model, effort, speed, orchestrator,
       permission_mode, review_provider, review_model, review_effort,
       built_in, created_at, updated_at)
    VALUES
      ('implicit', 'Opus low', 'claude', 'opus', 'low', NULL, 1,
       NULL, 'claude', 'opus', 'high', 0, 'now', 'now')
  `).run();
  for (const column of ["review_explicit", "review_provider", "review_model", "review_effort"]) {
    legacyDb.exec(`ALTER TABLE presets DROP COLUMN ${column}`);
  }
  legacyDb.close();

  const migrated = new PresetStore(openDb(dir));
  expect(migrated.get("implicit")).toMatchObject({
    review_provider: "claude",
    review_model: "opus",
    review_effort: "low",
    review_explicit: false,
  });
});

test("aligne aussi un preset personnalisé dont l'effort est NULL", () => {
  const dir = mkdtempSync(join(tmpdir(), "pupitre-presets-null-effort-migration-"));
  const legacyDb = openDb(dir);
  new PresetStore(legacyDb);
  legacyDb.query(`
    INSERT INTO presets
      (id, name, provider, model, effort, speed, orchestrator,
       permission_mode, review_provider, review_model, review_effort,
       built_in, created_at, updated_at)
    VALUES
      ('sans-effort', 'Luna', 'codex', 'gpt-5.6-luna', NULL, NULL, 1,
       NULL, 'codex', 'gpt-5.6-sol', 'high', 0, 'now', 'now')
  `).run();
  for (const column of ["review_explicit", "review_provider", "review_model", "review_effort"]) {
    legacyDb.exec(`ALTER TABLE presets DROP COLUMN ${column}`);
  }
  legacyDb.close();

  const migrated = new PresetStore(openDb(dir));
  expect(migrated.get("sans-effort")).toMatchObject({
    review_provider: "codex",
    review_model: "gpt-5.6-luna",
    review_effort: "high",
    review_explicit: false,
  });
});

test("préserve une review déjà saisie quand la base n'a pas encore de marqueur d'héritage", () => {
  const dir = mkdtempSync(join(tmpdir(), "pupitre-presets-ambiguous-review-"));
  const legacyDb = openDb(dir);
  new PresetStore(legacyDb);
  legacyDb.query(`
    INSERT INTO presets
      (id, name, provider, model, effort, speed, orchestrator,
       permission_mode, review_provider, review_model, review_effort,
       built_in, created_at, updated_at)
    VALUES
      ('choisi', 'Luna relue par Sol', 'codex', 'gpt-5.6-luna', 'low', 'standard', 1,
       NULL, 'codex', 'gpt-5.6-sol', 'high', 0, 'now', 'now')
  `).run();
  legacyDb.exec("ALTER TABLE presets DROP COLUMN review_explicit");
  legacyDb.close();

  const migrated = new PresetStore(openDb(dir));
  expect(migrated.get("choisi")).toMatchObject({
    review_provider: "codex",
    review_model: "gpt-5.6-sol",
    review_effort: "high",
    review_explicit: true,
  });
});

test("une review choisie est marquée explicite, une review héritée ne l'est pas", () => {
  const inherited = presets.create({
    name: "Hérité",
    provider: "codex",
    model: "gpt-5.6-luna",
    effort: "low",
    speed: "standard",
    orchestrator: true,
  });
  expect(inherited.review_explicit).toBe(false);

  const chosen = presets.create({
    name: "Choisi",
    provider: "codex",
    model: "gpt-5.6-luna",
    effort: "low",
    speed: "standard",
    orchestrator: true,
    review_provider: "codex",
    review_model: "gpt-5.6-sol",
    review_effort: "high",
  });
  expect(chosen.review_explicit).toBe(true);

  const renamed = presets.update(chosen.id, {
    name: "Toujours choisi",
    provider: "codex",
    model: "gpt-5.6-luna",
    effort: "low",
    speed: "standard",
    orchestrator: true,
  });
  expect(renamed?.review_explicit).toBe(true);
});

test("la permission d'un preset est optionnelle, canonique et persistante", () => {
  const inherited = presets.create({
    name: "Hérité",
    provider: "claude",
    model: "sonnet",
    effort: "high",
    speed: null,
    orchestrator: true,
  });
  expect(inherited.permission_mode).toBeNull();

  const autonomous = presets.create({
    name: "Autonome",
    provider: "claude",
    model: "sonnet",
    effort: "high",
    speed: null,
    orchestrator: true,
    permission_mode: "bypassPermissions",
  });
  expect(autonomous.permission_mode).toBe("bypassPermissions");

  const updated = presets.update(autonomous.id, {
    name: autonomous.name,
    provider: autonomous.provider,
    model: autonomous.model,
    effort: autonomous.effort,
    speed: autonomous.speed,
    orchestrator: autonomous.orchestrator,
    permission_mode: null,
  });
  expect(updated?.permission_mode).toBeNull();

  const restoredOnUpdate = presets.update(autonomous.id, {
    name: autonomous.name,
    provider: autonomous.provider,
    model: autonomous.model,
    effort: autonomous.effort,
    speed: autonomous.speed,
    orchestrator: autonomous.orchestrator,
    permission_mode: "bypassPermissions",
  });
  expect(restoredOnUpdate?.permission_mode).toBe("bypassPermissions");
});

test("les presets intégrés s'éditent et se restaurent, mais ne se suppriment pas", () => {
  const updated = presets.update("builtin-eco", {
    name: "Éco maison",
    provider: "claude",
    model: "haiku",
    effort: "medium",
    speed: null,
    orchestrator: false,
    review_provider: "claude",
    review_model: "sonnet",
    review_effort: "high",
  });
  expect(updated).toMatchObject({
    name: "Éco maison",
    provider: "claude",
    model: "haiku",
    orchestrator: false,
    review_model: "sonnet",
    // Le drapeau survit à l'édition : c'est lui qui rend la restauration possible.
    built_in: true,
  });

  const restored = presets.restore("builtin-eco");
  expect(restored).toMatchObject({
    name: "Éco",
    provider: "codex",
    model: "gpt-5.6-luna",
    effort: "low",
    speed: "standard",
    orchestrator: true,
    review_provider: "codex",
    review_model: "gpt-5.6-sol",
    review_effort: "high",
  });

  expect(() => presets.delete("builtin-eco")).toThrow("preset intégré non supprimable");
});

test("une édition d'un preset intégré survit au redémarrage", () => {
  const dir = mkdtempSync(join(tmpdir(), "pupitre-presets-restart-"));
  const first = new PresetStore(openDb(dir));
  first.update("builtin-quality", {
    name: "Qualité max",
    provider: "claude",
    model: "sonnet",
    effort: "high",
    speed: null,
    orchestrator: true,
    review_provider: "claude",
    review_model: "fable-5",
    review_effort: "high",
  });

  // Le seed au démarrage doit être un INSERT OR IGNORE pur : le moindre UPDATE
  // inconditionnel rejouerait les valeurs d'usine à chaque lancement.
  const second = new PresetStore(openDb(dir));
  expect(second.get("builtin-quality")).toMatchObject({
    model: "sonnet",
    review_model: "fable-5",
  });
});

test("un preset personnalisé n'a pas de valeurs d'origine à restaurer", () => {
  const custom = presets.create({
    name: "Perso",
    provider: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
    speed: "standard",
    orchestrator: true,
  });
  expect(() => presets.restore(custom.id)).toThrow("preset sans valeurs d'origine");
  expect(presets.restore("inconnu")).toBeNull();
});

test("un projet mémorise son preset par défaut et le perd si le preset est supprimé", () => {
  const project = projects.create({ name: "p", path: "/tmp/preset-project" });
  const custom = presets.create({
    name: "Projet",
    provider: "claude",
    model: "sonnet",
    effort: "medium",
    speed: null,
    orchestrator: true,
  });

  projects.setDefaultPreset(project.id, custom.id);
  expect(projects.get(project.id)?.default_preset_id).toBe(custom.id);
  presets.delete(custom.id);
  expect(projects.get(project.id)?.default_preset_id).toBeNull();
});
