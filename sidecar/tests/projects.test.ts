import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { FALLBACK_PROJECT_LAUNCH_CONFIG, ProjectStore, projectLaunchConfig } from "../src/stores/projects";
import { PresetStore } from "../src/stores/presets";
import { PROJECT_LAUNCH_CONFIG_MIGRATION_KEY } from "../src/stores/settings";

let store: ProjectStore;
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "pupitre-test-"));
  store = new ProjectStore(openDb(dir));
});

test("crée et liste un projet", () => {
  const p = store.create({ name: "spoilguard", path: "/home/clement/Desktop/spoilguard" });
  expect(p.id).toBeString();
  expect(store.list()).toHaveLength(1);
  expect(store.list()[0].name).toBe("spoilguard");
});

test("refuse un path en doublon", () => {
  store.create({ name: "a", path: "/tmp/x" });
  expect(() => store.create({ name: "b", path: "/tmp/x" })).toThrow();
});

test("épingle et désépingle", () => {
  const p = store.create({ name: "a", path: "/tmp/y" });
  store.setPinned(p.id, true);
  expect(store.list()[0].pinned).toBe(true);
});

test("applique le mode de permission porté par le preset par défaut", () => {
  const p = store.create({ name: "a", path: "/tmp/permission" });
  expect(p.permission_mode).toBe("acceptEdits");
  store.setPermissionMode(p.id, "bypassPermissions");
  expect(store.get(p.id)?.permission_mode).toBe("bypassPermissions");
});

test("les racines IA sont la portée filesystem par défaut", () => {
  const p = store.create({ name: "a", path: "/tmp/filesystem-default" });
  expect(p.filesystem_scope).toBe("project-and-ai-roots");
  store.setFilesystemScope(p.id, "full-system");
  expect(store.get(p.id)?.filesystem_scope).toBe("full-system");
});

test("les réglages de lancement du projet se replient sur le défaut du projet puis sur Pupitre", () => {
  const p = store.create({ name: "a", path: "/tmp/launch-config" });
  expect(p.default_launch_config).toBeNull();
  expect(projectLaunchConfig(p, "todo")).toEqual(FALLBACK_PROJECT_LAUNCH_CONFIG);
  const opus = { provider: "claude", model: "opus-5.5", effort: "medium", speed: "standard" } as const;
  store.setLaunchConfig(p.id, "default", opus);
  expect(projectLaunchConfig(store.get(p.id)!, "scout")).toEqual(opus);
  const luna = { provider: "codex", model: "gpt-6-luna", effort: "xhigh", speed: "fast" } as const;
  store.setLaunchConfig(p.id, "todo", luna);
  expect(projectLaunchConfig(store.get(p.id)!, "todo")).toEqual(luna);
  store.setLaunchConfig(p.id, "todo", null);
  expect(store.get(p.id)?.todo_launch_config).toBeNull();
});

test("la migration copie les presets de projet dans ses réglages et rétablit les presets intégrés", () => {
  const dir = mkdtempSync(join(tmpdir(), "pupitre-test-"));
  const db = openDb(dir);
  const projects = new ProjectStore(db);
  new PresetStore(db);
  const p = projects.create({ name: "a", path: "/tmp/launch-migration" });
  db.query("UPDATE presets SET name = 'Sol low', model = 'gpt-6-sol', effort = 'high', speed = 'standard' WHERE id = 'builtin-speed'").run();
  db.query("UPDATE projects SET default_preset_id = 'builtin-speed', default_scout_preset_id = 'builtin-eco' WHERE id = ?").run(p.id);
  db.query("DELETE FROM settings WHERE key = ?").run(PROJECT_LAUNCH_CONFIG_MIGRATION_KEY);
  db.close();

  const reopened = openDb(dir);
  const migrated = new ProjectStore(reopened).get(p.id)!;
  expect(migrated.default_launch_config).toEqual({ provider: "codex", model: "gpt-6-sol", effort: "high", speed: "standard" });
  expect(migrated.scout_launch_config).toEqual({ provider: "codex", model: "gpt-6-luna", effort: "xhigh", speed: "standard" });
  expect(migrated.todo_launch_config).toBeNull();
  expect(migrated.default_preset_id).toBeNull();
  expect(new PresetStore(reopened).get("builtin-speed")).toEqual(expect.objectContaining({ name: "Vitesse", model: "gpt-6-luna", effort: "xhigh", speed: "fast" }));
});
