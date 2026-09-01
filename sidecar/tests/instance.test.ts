import { expect, test } from "bun:test";
import { backgroundJobsEnabled, defaultDataDir, defaultPort, readInstance } from "../src/instance";

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
