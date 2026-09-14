import { beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { parseTestInventory } from "../src/testing";
import { ConversationStore } from "../src/stores/conversations";
import { ProjectStore } from "../src/stores/projects";
import { TestingStore } from "../src/stores/testing";

let db: Database;
let conversationId: string;

beforeEach(() => {
  db = openDb(mkdtempSync(join(tmpdir(), "pupitre-testing-")));
  const projects = new ProjectStore(db);
  const conversations = new ConversationStore(db);
  const project = projects.create({ name: "tests", path: tmpdir() });
  conversationId = conversations.create({ projectId: project.id, provider: "codex", model: "gpt-5.6-luna", firstMessage: "Teste l'API" }).id;
});

test("parse un inventaire structuré", () => {
  expect(parseTestInventory(`{"items":[{"title":"API","description":"Contrat","methods":[{"kind":"unit","label":"Tests","instructions":"bun test"}]}]}`))
    .toEqual([{ title: "API", description: "Contrat", methods: [{ kind: "unit", label: "Tests", instructions: "bun test" }] }]);
});

test("un redémarrage clôt un scope en cours", () => {
  const store = new TestingStore(db);
  const inventory = store.createWithReference({ conversationId, eventIdFrom: 1, eventIdTo: 1, scopes: [{ title: "API", description: "Test", methods: [{ kind: "unit", label: "Tests", instructions: "bun test" }] }] }).inventory;
  const scope = store.reserveScope(inventory.scopes[0]!.id)!;
  store.attachSubtask(scope.id, "subtask-interrompue");
  const restarted = new TestingStore(db);
  expect(restarted.getScope(scope.id)).toMatchObject({ status: "failed", error: "interrompu (sidecar redémarré)" });
});
