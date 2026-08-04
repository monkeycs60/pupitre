import { test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { ProjectStore } from "../src/stores/projects";
import { ConversationStore } from "../src/stores/conversations";

let convs: ConversationStore;
let projectId: string;
let db: ReturnType<typeof openDb>;
beforeEach(() => {
  db = openDb(mkdtempSync(join(tmpdir(), "pupitre-test-")));
  projectId = new ProjectStore(db).create({ name: "p", path: "/tmp/p" }).id;
  convs = new ConversationStore(db);
});

test("crée une conversation avec titre dérivé du premier message", () => {
  const c = convs.create({ projectId, provider: "claude", model: "opus", firstMessage: "Corrige le bug du lightbox sur mobile s'il te plaît" });
  expect(c.title).toBe("Corrige le bug du lightbox sur mobile s'il te p…");
  expect(c.cli_session_id).toBeNull();
  expect(c.effort).toBeNull();
  expect(c.speed).toBeNull();
});

test("crée une conversation avec une vitesse persistée", () => {
  const c = convs.create({
    projectId,
    provider: "codex",
    model: "gpt-5.6-luna",
    speed: "fast",
    firstMessage: "Réponds vite",
  });

  expect(c.speed).toBe("fast");
  expect(convs.get(c.id)?.speed).toBe("fast");
});

test("crée une conversation avec un effort persisté", () => {
  const c = convs.create({
    projectId,
    provider: "claude",
    model: "opus",
    effort: "xhigh",
    firstMessage: "Analyse ce bug",
  });

  expect(c.effort).toBe("xhigh");
  expect(convs.get(c.id)?.effort).toBe("xhigh");
});

test("migre une base existante et la migration reste idempotente", () => {
  const dir = mkdtempSync(join(tmpdir(), "pupitre-legacy-"));
  const legacy = new Database(join(dir, "pupitre.db"));
  legacy.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
      title TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
      cli_session_id TEXT, pinned INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  legacy.close();

  const migrated = openDb(dir);
  migrated.close();
  const reopened = openDb(dir);
  const effortColumn = (reopened.query("PRAGMA table_info(conversations)").all() as Array<{
    name: string;
    type: string;
    notnull: number;
  }>).find((column) => column.name === "effort");
  const speedColumn = (reopened.query("PRAGMA table_info(conversations)").all() as Array<{
    name: string;
    type: string;
    notnull: number;
  }>).find((column) => column.name === "speed");

  expect(effortColumn).toMatchObject({ type: "TEXT", notnull: 0 });
  expect(speedColumn).toMatchObject({ type: "TEXT", notnull: 0 });
  reopened.close();
});

test("appendEvent + listEvents rejouent dans l'ordre", () => {
  const c = convs.create({ projectId, provider: "claude", model: "opus", firstMessage: "x" });
  convs.appendEvent(c.id, { type: "text-delta", text: "a" });
  convs.appendEvent(c.id, { type: "text-delta", text: "b" });
  expect(convs.listEvents(c.id).map((e: any) => e.text)).toEqual(["a", "b"]);
});

test("appendEvent retourne l'id inséré, exposé par listEvents en ordre croissant", () => {
  const c = convs.create({ projectId, provider: "claude", model: "opus", firstMessage: "x" });
  const firstId = convs.appendEvent(c.id, { type: "text-delta", text: "a" });
  const secondId = convs.appendEvent(c.id, { type: "text-delta", text: "b" });

  expect(typeof firstId).toBe("number");
  expect(secondId).toBeGreaterThan(firstId);
  expect(convs.listEvents(c.id)).toEqual([
    { id: firstId, type: "text-delta", text: "a" },
    { id: secondId, type: "text-delta", text: "b" },
  ]);
});

test("les ids d'événements sont uniques entre conversations", () => {
  const first = convs.create({ projectId, provider: "claude", model: "opus", firstMessage: "x" });
  const second = convs.create({ projectId, provider: "claude", model: "opus", firstMessage: "y" });
  const firstId = convs.appendEvent(first.id, { type: "text-delta", text: "a" });
  const secondId = convs.appendEvent(second.id, { type: "text-delta", text: "b" });

  expect(firstId).not.toBe(secondId);
});

test("listEvents ignore une ligne corrompue et poursuit la lecture", () => {
  const c = convs.create({ projectId, provider: "claude", model: "opus", firstMessage: "x" });
  const beforeId = convs.appendEvent(c.id, { type: "text-delta", text: "avant" });
  db.query("INSERT INTO events (conversation_id, payload, created_at) VALUES (?, ?, ?)")
    .run(c.id, "{invalide", new Date().toISOString());
  const afterId = convs.appendEvent(c.id, { type: "text-delta", text: "après" });
  const errors: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => errors.push(args);

  try {
    expect(convs.listEvents(c.id)).toEqual([
      { id: beforeId, type: "text-delta", text: "avant" },
      { id: afterId, type: "text-delta", text: "après" },
    ]);
  } finally {
    console.error = originalConsoleError;
  }
  expect(errors).toHaveLength(1);
});

test("active les contraintes de clés étrangères", () => {
  const pragma = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number };
  expect(pragma.foreign_keys).toBe(1);
});

test("setCliSessionId persiste pour la reprise", () => {
  const c = convs.create({ projectId, provider: "codex", model: "gpt-5.6-luna", firstMessage: "x" });
  convs.setCliSessionId(c.id, "abc-123");
  expect(convs.get(c.id)!.cli_session_id).toBe("abc-123");
});
