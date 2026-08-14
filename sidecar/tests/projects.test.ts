import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { ProjectStore } from "../src/stores/projects";

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

test("sépare les presets par défaut du chat, de la review et de la correction", () => {
  const p = store.create({ name: "a", path: "/tmp/preset-defaults" });
  store.setDefaultPreset(p.id, "chat-preset");
  store.setDefaultReviewPreset(p.id, "review-preset");
  store.setDefaultCorrectionPreset(p.id, "correction-preset");
  expect(store.get(p.id)).toEqual(expect.objectContaining({
    default_preset_id: "chat-preset",
    default_review_preset_id: "review-preset",
    default_correction_preset_id: "correction-preset",
  }));
});
