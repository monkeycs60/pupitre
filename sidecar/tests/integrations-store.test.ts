import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { ProjectStore } from "../src/stores/projects";
import { IntegrationStore } from "../src/stores/integrations";

let store: IntegrationStore;
let projectId: string;

beforeEach(() => {
  const db = openDb(mkdtempSync(join(tmpdir(), "pupitre-integrations-")));
  const projects = new ProjectStore(db);
  projectId = projects.create({ name: "mono", path: "/tmp/mono" }).id;
  store = new IntegrationStore(db);
});

test("upsert d'une intégration par (projet, type)", () => {
  const created = store.upsert(projectId, "gitlab", {
    config: { host: "https://git.example", projects: [] },
    branchPattern: "^(issue|feature)/(TECH-\\d+)",
  });
  expect(created.status).toBe("non configurée");
  const updated = store.upsert(projectId, "gitlab", { config: { host: "https://git.other", projects: [] } });
  expect(updated.id).toBe(created.id);
  expect(updated.config).toEqual({ host: "https://git.other", projects: [] });
  expect(updated.branch_pattern).toBe("^(issue|feature)/(TECH-\\d+)");
  expect(store.listByProject(projectId)).toHaveLength(1);
});

test("refuse un motif de branche invalide", () => {
  expect(() => store.upsert(projectId, "clickup", { config: {}, branchPattern: "(" })).toThrow();
});

test("refuse aussi un motif de branche vide", () => {
  expect(() => store.upsert(projectId, "clickup", { config: {}, branchPattern: "" })).toThrow();
});

test("statut, erreur et snapshot", () => {
  const item = store.upsert(projectId, "clickup", { config: { teamId: "1", listIds: [] } });
  store.markOk(item.id, { tasks: 3 });
  expect(store.get(item.id)).toEqual(expect.objectContaining({ status: "ok", last_error: null, snapshot: { tasks: 3 } }));
  store.markError(item.id, "dégradée", "timeout");
  expect(store.get(item.id)).toEqual(expect.objectContaining({ status: "dégradée", last_error: "timeout", snapshot: { tasks: 3 } }));
  store.markError(item.id, "à reconfigurer", "401");
  expect(store.get(item.id)?.status).toBe("à reconfigurer");
});

test("suppression", () => {
  const item = store.upsert(projectId, "clickup", { config: {} });
  expect(store.remove(item.id)).toBe(true);
  expect(store.listByProject(projectId)).toHaveLength(0);
});
