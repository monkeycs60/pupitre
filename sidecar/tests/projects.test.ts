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
