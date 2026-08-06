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
