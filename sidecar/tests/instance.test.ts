import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backgroundJobsEnabled,
  buildInfo,
  defaultDataDir,
  defaultPort,
  readInstance,
  staleSourcesSince,
} from "../src/instance";

test("les défauts distinguent les instances stable et dev", () => {
  expect(defaultPort("stable")).toBe(4820);
  expect(defaultPort("dev")).toBe(4821);
  expect(defaultDataDir("stable", "/home/test")).toBe("/home/test/.local/share/pupitre");
  expect(defaultDataDir("dev", "/home/test")).toBe("/home/test/.local/share/pupitre-dev");
  expect(readInstance({ HOME: "/home/test" })).toEqual({
    name: "stable",
    port: 4820,
    dataDir: "/home/test/.local/share/pupitre",
  });
  expect(readInstance({ HOME: "/home/test", PUPITRE_INSTANCE: "dev" })).toEqual({
    name: "dev",
    port: 4821,
    dataDir: "/home/test/.local/share/pupitre-dev",
  });
});

test("les variables explicites gardent la priorité", () => {
  expect(readInstance({
    PUPITRE_INSTANCE: "dev",
    PUPITRE_PORT: "4900",
    PUPITRE_DATA_DIR: "/tmp/pupitre-test",
  })).toEqual({ name: "dev", port: 4900, dataDir: "/tmp/pupitre-test" });
});

test("les valeurs d'instance et de port invalides sont refusées", () => {
  expect(() => readInstance({ PUPITRE_INSTANCE: "preview" })).toThrow("PUPITRE_INSTANCE invalide");
  for (const port of ["", "1.5", "-1", "65536", "abc"]) {
    expect(() => readInstance({ PUPITRE_PORT: port })).toThrow("PUPITRE_PORT invalide");
  }
});

test("les tâches de fond suivent l'instance sauf surcharge explicite", () => {
  expect(backgroundJobsEnabled({ PUPITRE_INSTANCE: "stable" })).toBe(true);
  expect(backgroundJobsEnabled({ PUPITRE_INSTANCE: "dev" })).toBe(false);
  expect(backgroundJobsEnabled({ PUPITRE_INSTANCE: "dev", PUPITRE_BACKGROUND_JOBS: "on" })).toBe(true);
  expect(backgroundJobsEnabled({ PUPITRE_INSTANCE: "stable", PUPITRE_BACKGROUND_JOBS: "off" })).toBe(false);
});

test("le build embarqué expose son SHA sans consulter Git", () => {
  expect(buildInfo({ PUPITRE_BUILD_SHA: "a3c164b", PUPITRE_BUILD_DIRTY: "1" })).toEqual({
    sha: "a3c164b",
    dirty: true,
    source: "build",
  });
});

test("les sources vivantes exposent le commit et leur état Git", () => {
  const root = mkdtempSync(join(tmpdir(), "pupitre-instance-git-"));
  Bun.spawnSync(["git", "init"], { cwd: root });
  Bun.spawnSync(["git", "config", "user.email", "test@example.com"], { cwd: root });
  Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: root });
  writeFileSync(join(root, "tracked.ts"), "export const value = 1\n");
  Bun.spawnSync(["git", "add", "."], { cwd: root });
  Bun.spawnSync(["git", "commit", "-m", "initial"], { cwd: root });
  const clean = buildInfo({}, root);
  expect(clean.source).toBe("git");
  expect(clean.sha).toMatch(/^[0-9a-f]+$/);
  expect(clean.dirty).toBe(false);
  writeFileSync(join(root, "tracked.ts"), "export const value = 2\n");
  expect(buildInfo({}, root).dirty).toBe(true);
});

test("compte uniquement les sources TypeScript modifiées après le démarrage", () => {
  const dir = mkdtempSync(join(tmpdir(), "pupitre-stale-"));
  mkdirSync(join(dir, "nested"));
  const before = join(dir, "before.ts");
  const after = join(dir, "nested", "after.ts");
  const ignored = join(dir, "after.txt");
  writeFileSync(before, "");
  writeFileSync(after, "");
  writeFileSync(ignored, "");
  const startedAt = Date.now();
  utimesSync(before, new Date(startedAt - 1_000), new Date(startedAt - 1_000));
  utimesSync(after, new Date(startedAt + 1_000), new Date(startedAt + 1_000));
  utimesSync(ignored, new Date(startedAt + 1_000), new Date(startedAt + 1_000));
  expect(staleSourcesSince(startedAt, dir, { source: "git", sha: "test", dirty: false })).toBe(1);
  expect(staleSourcesSince(startedAt, dir, { source: "build", sha: "test", dirty: false })).toBe(0);
});

test("Rust conserve les mêmes défauts d'instance que le sidecar", () => {
  const rust = readFileSync(join(import.meta.dir, "..", "..", "src-tauri", "src", "lib.rs"), "utf8");
  const reader = rust.match(/fn read_instance_env\(\)[\s\S]*?\n}/)?.[0] ?? "";
  expect(reader).toContain('name == "dev"');
  expect(reader).toContain("4821");
  expect(reader).toContain("4820");
});
