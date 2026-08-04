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

test("refuse la modification et la suppression des presets intégrés", () => {
  const builtIn = presets.list()[0]!;
  expect(() => presets.update(builtIn.id, {
    name: "Éco modifié",
    provider: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
    speed: "fast",
    orchestrator: false,
  })).toThrow("preset intégré immuable");
  expect(() => presets.delete(builtIn.id)).toThrow("preset intégré immuable");
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
