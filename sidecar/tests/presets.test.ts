import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { FABLE_52_MIGRATION_KEY, SettingsStore } from "../src/stores/settings";
import { PresetStore } from "../src/stores/presets";

test("initialise les presets intégrés et gère les presets personnalisés", () => {
  const db = openDb(mkdtempSync(join(tmpdir(), "pupitre-presets-")));
  const store = new PresetStore(db);
  expect(store.list().map((preset) => preset.id)).toEqual(["builtin-eco", "builtin-quality", "builtin-speed"]);
  const created = store.create({ name: "Personnel", provider: "codex", model: "gpt-5.6-sol", effort: "high", speed: "standard", permission_mode: "dontAsk" });
  expect(store.get(created.id)).toMatchObject({ name: "Personnel", permission_mode: "dontAsk" });
  expect(store.update(created.id, { name: "Rapide", provider: "codex", model: "gpt-5.6-luna", effort: "low", speed: "fast", permission_mode: null })).toMatchObject({ name: "Rapide", speed: "fast" });
  expect(store.delete(created.id)).toBe(true);
  expect(store.get(created.id)).toBeNull();
  db.close();
});

test("restaure un preset intégré et refuse sa suppression", () => {
  const db = openDb(mkdtempSync(join(tmpdir(), "pupitre-presets-")));
  const store = new PresetStore(db);
  store.update("builtin-speed", { name: "Modifié", provider: "claude", model: "haiku", effort: "medium", speed: null, permission_mode: null });
  expect(store.restore("builtin-speed")).toMatchObject({ name: "Vitesse", provider: "codex", model: "gpt-6-luna", speed: "fast" });
  expect(() => store.delete("builtin-speed")).toThrow("non supprimable");
  db.close();
});

test("Fable 5.1 quitte le catalogue : les réglages enregistrés passent sur Fable 5.2", () => {
  const dir = mkdtempSync(join(tmpdir(), "pupitre-presets-"));
  let db = openDb(dir);
  expect(new PresetStore(db).get("builtin-quality")).toMatchObject({ model: "fable-5.2" });
  const store = new PresetStore(db);
  const custom = store.create({ name: "Fable", provider: "claude", model: "fable-5.1", effort: "high", speed: "fast", permission_mode: null });
  const sonnet = store.create({ name: "Sonnet", provider: "claude", model: "sonnet-5.5", effort: "high", speed: null, permission_mode: null });
  db.query("UPDATE presets SET model = 'fable-5.1' WHERE id = 'builtin-quality'").run();
  const projectId = (db.query("INSERT INTO projects (id, name, path, created_at, default_launch_config) VALUES ('p1', 'p1', '/tmp/p1', '2026-11-10', ?) RETURNING id")
    .get(JSON.stringify({ provider: "claude", model: "fable-5.1", effort: "max", speed: "standard" })) as { id: string }).id;
  new SettingsStore(db).set("ticketAuditConfig", { provider: "claude", model: "fable-5.1", effort: "xhigh" });
  db.query("DELETE FROM settings WHERE key = ?").run(FABLE_52_MIGRATION_KEY);
  db.close();

  db = openDb(dir);
  const migrated = new PresetStore(db);
  expect(migrated.get("builtin-quality")).toMatchObject({ model: "fable-5.2", effort: "max" });
  expect(migrated.get(custom.id)).toMatchObject({ model: "fable-5.2", effort: "high", speed: "fast" });
  expect(migrated.get(sonnet.id)).toMatchObject({ model: "sonnet-5.5" });
  const project = db.query("SELECT default_launch_config FROM projects WHERE id = ?").get(projectId) as { default_launch_config: string };
  expect(JSON.parse(project.default_launch_config)).toEqual({ provider: "claude", model: "fable-5.2", effort: "max", speed: "standard" });
  expect(new SettingsStore(db).get<Record<string, unknown>>("ticketAuditConfig")).toEqual({ provider: "claude", model: "fable-5.2", effort: "xhigh" });
  db.close();
});
