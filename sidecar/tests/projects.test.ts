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

test("un nouveau projet démarre en YOLO", () => {
  const p = store.create({ name: "a", path: "/tmp/permission" });
  expect(p.permission_mode).toBe("bypassPermissions");
  store.setPermissionMode(p.id, "acceptEdits");
  expect(store.get(p.id)?.permission_mode).toBe("acceptEdits");
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

test("les anciens réglages de projet Claude utilisent les modèles 5.5", () => {
  const project = store.create({ name: "a", path: "/tmp/legacy-claude" });
  store.setLaunchConfig(project.id, "default", { provider: "claude", model: "opus", effort: "medium", speed: "standard" });
  store.setLaunchConfig(project.id, "scout", { provider: "claude", model: "sonnet", effort: "high", speed: "standard" });

  expect(projectLaunchConfig(store.get(project.id)!, "default").model).toBe("opus-5.5");
  expect(projectLaunchConfig(store.get(project.id)!, "scout").model).toBe("sonnet-5.5");
});

test("la migration copie les presets de projet dans ses réglages et rétablit les presets intégrés", () => {
  const dir = mkdtempSync(join(tmpdir(), "pupitre-test-"));
  const db = openDb(dir);
  const projects = new ProjectStore(db);
  new PresetStore(db);
  const p = projects.create({ name: "a", path: "/tmp/launch-migration" });
  db.query("UPDATE presets SET name = 'Sol high', model = 'gpt-6.1-sol', effort = 'high', speed = 'standard' WHERE id = 'builtin-speed'").run();
  db.query("UPDATE projects SET default_preset_id = 'builtin-speed', default_scout_preset_id = 'builtin-eco' WHERE id = ?").run(p.id);
  db.query("DELETE FROM settings WHERE key = ?").run(PROJECT_LAUNCH_CONFIG_MIGRATION_KEY);
  db.close();

  const reopened = openDb(dir);
  const migrated = new ProjectStore(reopened).get(p.id)!;
  expect(migrated.default_launch_config).toEqual({ provider: "codex", model: "gpt-6.1-sol", effort: "high", speed: "standard" });
  expect(migrated.scout_launch_config).toEqual({ provider: "codex", model: "gpt-6-luna", effort: "xhigh", speed: "standard" });
  expect(migrated.todo_launch_config).toBeNull();
  expect(migrated.default_preset_id).toBeNull();
  expect(new PresetStore(reopened).get("builtin-speed")).toEqual(expect.objectContaining({ name: "Vitesse", model: "gpt-6-luna", effort: "xhigh", speed: "fast" }));
});

test("un groupe réunit des projets, se renomme et se dissout sans les perdre", () => {
  const p15 = store.create({ name: "P15", path: "/tmp/p15" });
  const rebuttal = store.create({ name: "2026_MMVD_REBUTTAL", path: "/tmp/rebuttal" });
  const other = store.create({ name: "larib-portal", path: "/tmp/larib" });
  const group = store.createGroup("  MMVD ", [p15.id, rebuttal.id]);
  expect(group.name).toBe("MMVD");
  expect(group.color).toMatch(/^#[0-9a-f]{6}$/);
  expect(store.list().map((project) => [project.name, project.group_id])).toEqual(expect.arrayContaining([
    ["P15", group.id], ["2026_MMVD_REBUTTAL", group.id], ["larib-portal", null],
  ]));

  store.updateGroup(group.id, { name: "Étude MMVD", color: "#4F8CFF" });
  expect(store.group(group.id)).toMatchObject({ name: "Étude MMVD", color: "#4f8cff" });
  expect(() => store.updateGroup(group.id, { name: "  " })).toThrow("nom de groupe invalide");
  expect(() => store.setGroup(other.id, "inconnu")).toThrow("groupe inconnu");

  store.removeGroup(group.id);
  expect(store.groups()).toEqual([]);
  expect(store.list()).toHaveLength(3);
  expect(store.list().every((project) => project.group_id === null)).toBe(true);
});

test("deux groupes reçoivent des couleurs différentes", () => {
  const first = store.createGroup("MMVD");
  const second = store.createGroup("INFLAME");
  expect(first.color).not.toBe(second.color);
});
