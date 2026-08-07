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

test("persiste et modifie le mode de permission d'une conversation", () => {
  const c = convs.create({
    projectId,
    provider: "claude",
    model: "opus",
    permissionMode: "bypassPermissions",
    firstMessage: "Active le mode YOLO",
  });

  expect(c.permission_mode).toBe("bypassPermissions");
  expect(convs.setPermissionMode(c.id, null)?.permission_mode).toBeNull();
});

test("met à jour le modèle dans le même provider et estime la ré-ingestion", () => {
  const c = convs.create({
    projectId,
    provider: "claude",
    model: "haiku",
    effort: "low",
    firstMessage: "Analyse",
  });
  convs.appendEvent(c.id, { type: "usage", inputTokens: 120, outputTokens: 30 });
  convs.appendEvent(c.id, { type: "usage", inputTokens: 80, outputTokens: 20 });

  convs.updateModel(c.id, {
    model: "sonnet",
    effort: "high",
    speed: null,
  });

  expect(convs.get(c.id)).toMatchObject({
    provider: "claude",
    model: "sonnet",
    effort: "high",
    speed: null,
  });
  expect(convs.usageTokens(c.id)).toBe(250);
});

test("lie une conversation de passation à sa source", () => {
  const source = convs.create({
    projectId,
    provider: "claude",
    model: "sonnet",
    firstMessage: "Construis la fonctionnalité",
  });
  const continuation = convs.create({
    projectId,
    provider: "codex",
    model: "gpt-5.6-sol",
    continuedFrom: source.id,
    firstMessage: `Suite de ${source.title}`,
  });

  expect(continuation.continued_from).toBe(source.id);
  expect(convs.listByProject(projectId)).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: continuation.id, continued_from: source.id }),
  ]));
});

test("supprime une continuation ratée avec ses sous-tâches et tous leurs événements", () => {
  const source = convs.create({
    projectId,
    provider: "claude",
    model: "sonnet",
    firstMessage: "Source",
  });
  const continuation = convs.create({
    projectId,
    provider: "codex",
    model: "gpt-5.6-sol",
    continuedFrom: source.id,
    handoffPending: true,
    firstMessage: "Suite",
  });
  convs.appendEvent(continuation.id, { type: "status", state: "error" });
  db.query(`
    INSERT INTO subtasks
      (id, conversation_id, provider, model, prompt, status, created_at, updated_at)
    VALUES ('subtask-test', ?, 'claude', 'haiku', 'test', 'error', ?, ?)
  `).run(continuation.id, new Date().toISOString(), new Date().toISOString());
  convs.appendEvent("subtask-test", { type: "status", state: "error" });

  expect(convs.deleteFailedContinuation(continuation.id)).toBe(true);
  expect(convs.get(continuation.id)).toBeNull();
  expect(convs.listEvents(continuation.id)).toEqual([]);
  expect(convs.listEvents("subtask-test")).toEqual([]);
  expect(db.query("SELECT id FROM subtasks WHERE conversation_id = ?")
    .all(continuation.id)).toEqual([]);
  expect(convs.get(source.id)).not.toBeNull();
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
  const continuedFromColumn = (reopened.query("PRAGMA table_info(conversations)").all() as Array<{
    name: string;
    type: string;
    notnull: number;
  }>).find((column) => column.name === "continued_from");
  const handoffPendingColumn = (reopened.query("PRAGMA table_info(conversations)").all() as Array<{
    name: string;
    type: string;
    notnull: number;
  }>).find((column) => column.name === "handoff_pending");

  expect(effortColumn).toMatchObject({ type: "TEXT", notnull: 0 });
  expect(speedColumn).toMatchObject({ type: "TEXT", notnull: 0 });
  expect(continuedFromColumn).toMatchObject({ type: "TEXT", notnull: 0 });
  expect(handoffPendingColumn).toMatchObject({ type: "INTEGER", notnull: 1 });
  reopened.close();
});

test("nettoie au redémarrage uniquement les handoffs restés en attente", () => {
  const source = convs.create({
    projectId,
    provider: "claude",
    model: "sonnet",
    firstMessage: "Source",
  });
  const interrupted = convs.create({
    projectId,
    provider: "codex",
    model: "gpt-5.6-sol",
    continuedFrom: source.id,
    handoffPending: true,
    firstMessage: "Suite interrompue",
  });
  const completed = convs.create({
    projectId,
    provider: "codex",
    model: "gpt-5.6-sol",
    continuedFrom: source.id,
    handoffPending: true,
    firstMessage: "Suite réussie",
  });
  expect(convs.completeHandoff(completed.id)).toBe(true);
  const persistedDone = convs.create({
    projectId,
    provider: "codex",
    model: "gpt-5.6-sol",
    continuedFrom: source.id,
    handoffPending: true,
    firstMessage: "Suite persistée avant crash",
  });
  convs.appendEvent(persistedDone.id, { type: "status", state: "running" });
  convs.appendEvent(persistedDone.id, { type: "status", state: "done" });

  expect(convs.sweepPendingHandoffs()).toBe(1);
  expect(convs.get(interrupted.id)).toBeNull();
  expect(convs.get(completed.id)).toMatchObject({ handoff_pending: false });
  expect(convs.get(persistedDone.id)).toMatchObject({ handoff_pending: false });
  expect(convs.listEvents(persistedDone.id).at(-1)).toMatchObject({
    type: "status",
    state: "done",
  });
  expect(convs.get(source.id)).not.toBeNull();
});

test("appendEvent + listEvents rejouent dans l'ordre", () => {
  const c = convs.create({ projectId, provider: "claude", model: "opus", firstMessage: "x" });
  convs.appendEvent(c.id, { type: "text-delta", text: "a" });
  convs.appendEvent(c.id, { type: "text-delta", text: "b" });
  expect(convs.listEvents(c.id).map((e: any) => e.text)).toEqual(["a", "b"]);
});

test("compacte les suites de text-delta sans déplacer les autres événements", () => {
  const c = convs.create({ projectId, provider: "claude", model: "opus", firstMessage: "x" });
  const firstDeltaId = convs.appendEvent(c.id, { type: "text-delta", text: "bon" });
  convs.appendEvent(c.id, { type: "text-delta", text: "jour" });
  const toolId = convs.appendEvent(c.id, {
    type: "tool-start",
    toolId: "outil-1",
    toolName: "Read",
    input: {},
  });
  const secondDeltaId = convs.appendEvent(c.id, { type: "text-delta", text: "ap" });
  convs.appendEvent(c.id, { type: "text-delta", text: "rès" });

  expect(convs.compactTextDeltas(c.id)).toBe(2);
  expect(convs.listEvents(c.id)).toEqual([
    { id: firstDeltaId, type: "text-delta", text: "bonjour" },
    { id: toolId, type: "tool-start", toolId: "outil-1", toolName: "Read", input: {} },
    { id: secondDeltaId, type: "text-delta", text: "après" },
  ]);
  expect(convs.compactTextDeltas(c.id)).toBe(0);
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

test("appendEvent annule l'insertion si la mise à jour de conversation échoue", () => {
  const c = convs.create({ projectId, provider: "claude", model: "opus", firstMessage: "x" });
  db.exec(`
    CREATE TRIGGER refuse_conversation_update
    BEFORE UPDATE ON conversations
    BEGIN
      SELECT RAISE(ABORT, 'mise à jour refusée');
    END;
  `);

  expect(() => convs.appendEvent(c.id, { type: "text-delta", text: "perdu" }))
    .toThrow("mise à jour refusée");
  expect(convs.listEvents(c.id)).toEqual([]);
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

test("le sweep SQL clôt seulement le dernier status running des conversations", () => {
  const running = convs.create({
    projectId,
    provider: "claude",
    model: "opus",
    firstMessage: "running",
  });
  const done = convs.create({
    projectId,
    provider: "claude",
    model: "opus",
    firstMessage: "done",
  });
  const runningId = convs.appendEvent(running.id, { type: "status", state: "running" });
  convs.appendEvent(done.id, { type: "status", state: "running" });
  convs.appendEvent(done.id, { type: "status", state: "done" });
  convs.appendEvent("subtask-sans-conversation", { type: "status", state: "running" });

  expect(convs.sweepOrphanedRuns()).toBe(1);
  expect(convs.listEvents(running.id)).toEqual([{
    id: runningId,
    type: "status",
    state: "error",
    error: "interrompu (sidecar redémarré)",
  }]);
  expect(convs.listEvents(done.id).at(-1)).toMatchObject({ state: "done" });
  expect(convs.listEvents("subtask-sans-conversation").at(-1))
    .toMatchObject({ state: "running" });
});

test("le sweep clôt un tour interrompu même si des deltas suivent le status", () => {
  const conversation = convs.create({
    projectId,
    provider: "claude",
    model: "opus",
    firstMessage: "tour coupé en plein streaming",
  });
  const statusId = convs.appendEvent(conversation.id, { type: "status", state: "running" });
  convs.appendEvent(conversation.id, { type: "text-delta", text: "réponse partielle" });

  expect(convs.sweepOrphanedRuns()).toBe(1);
  expect(convs.listEvents(conversation.id).filter((event) => event.type === "status")).toEqual([{
    id: statusId,
    type: "status",
    state: "error",
    error: "interrompu (sidecar redémarré)",
  }]);
});

test("setCliSessionId persiste pour la reprise", () => {
  const c = convs.create({ projectId, provider: "codex", model: "gpt-5.6-luna", firstMessage: "x" });
  convs.setCliSessionId(c.id, "abc-123");
  expect(convs.get(c.id)!.cli_session_id).toBe("abc-123");
});
