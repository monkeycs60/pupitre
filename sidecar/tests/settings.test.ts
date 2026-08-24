import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { SettingsStore } from "../src/stores/settings";

let settings: SettingsStore;
let db: Database;

beforeEach(() => {
  db = openDb(mkdtempSync(join(tmpdir(), "pupitre-settings-")));
  settings = new SettingsStore(db);
});

test("refuse toute valeur qui ne peut pas être encodée en JSON", () => {
  expect(() => settings.set("undefined", undefined)).toThrow(TypeError);
  expect(() => settings.set("bigint", 1n)).toThrow(TypeError);
});

test("bloque aussi le JSON invalide écrit directement en SQL", () => {
  expect(() => db.query("INSERT INTO settings (key, value) VALUES (?, ?)")
    .run("cassé", "valeur brute"))
    .toThrow("settings.value doit contenir du JSON valide");
  expect(settings.all()).toEqual({});
});

test("stocke des valeurs JSON typées par clé", () => {
  expect(settings.get("quotaThresholds")).toBeNull();
  settings.set("quotaThresholds", { lastHour: false, usedPercent: 92 });
  expect(settings.get<{ lastHour: boolean; usedPercent: number }>("quotaThresholds"))
    .toEqual({ lastHour: false, usedPercent: 92 });
  expect(settings.all()).toEqual({
    quotaThresholds: { lastHour: false, usedPercent: 92 },
  });
});
