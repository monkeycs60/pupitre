import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { SettingsStore } from "../src/stores/settings";

let settings: SettingsStore;

beforeEach(() => {
  settings = new SettingsStore(openDb(mkdtempSync(join(tmpdir(), "pupitre-settings-"))));
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
