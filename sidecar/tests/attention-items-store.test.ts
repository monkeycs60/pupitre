import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { AttentionItemStore } from "../src/stores/attention-items";
import { ProjectStore } from "../src/stores/projects";

test("un signal acquitté réapparaît seulement quand sa version change", () => {
  const db = openDb(mkdtempSync(join(tmpdir(), "pupitre-attention-")));
  const project = new ProjectStore(db).create({ name: "Pupitre", path: `/tmp/pupitre-${crypto.randomUUID()}` });
  const store = new AttentionItemStore(db);
  const base = {
    type: "turn-error", projectId: project.id, sourceKey: "turn:1", severity: "error" as const,
    title: "Tour en échec", body: "Erreur", target: { kind: "conversation" as const, projectId: project.id, conversationId: "c1" },
  };
  const first = store.upsert({ ...base, conditionVersion: "v1" });
  expect(store.list()).toHaveLength(1);
  store.acknowledge(first.id);
  expect(store.list()).toHaveLength(0);
  store.upsert({ ...base, conditionVersion: "v1" });
  expect(store.list()).toHaveLength(0);
  store.upsert({ ...base, conditionVersion: "v2" });
  expect(store.list()).toHaveLength(1);
});
