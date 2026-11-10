import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { QUALITY_FABLE_52_MIGRATION_KEY } from "../src/stores/settings";
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

test("passe Qualité max sur Fable 5.2 sans écraser une personnalisation", () => {
  const dir = mkdtempSync(join(tmpdir(), "pupitre-presets-"));
  let db = openDb(dir);
  expect(new PresetStore(db).get("builtin-quality")).toMatchObject({ model: "fable-5.2" });
  db.query("UPDATE presets SET model = 'fable-5.1' WHERE id = 'builtin-quality'").run();
  db.query("DELETE FROM settings WHERE key = ?").run(QUALITY_FABLE_52_MIGRATION_KEY);
  db.close();
  db = openDb(dir);
  expect(new PresetStore(db).get("builtin-quality")).toMatchObject({ model: "fable-5.2" });
  db.query("UPDATE presets SET model = 'sonnet-5.5' WHERE id = 'builtin-quality'").run();
  db.query("DELETE FROM settings WHERE key = ?").run(QUALITY_FABLE_52_MIGRATION_KEY);
  db.close();
  db = openDb(dir);
  expect(new PresetStore(db).get("builtin-quality")).toMatchObject({ model: "sonnet-5.5" });
  db.close();
});
