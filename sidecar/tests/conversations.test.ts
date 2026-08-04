import { test, expect, beforeEach } from "bun:test";
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
});

test("appendEvent + listEvents rejouent dans l'ordre", () => {
  const c = convs.create({ projectId, provider: "claude", model: "opus", firstMessage: "x" });
  convs.appendEvent(c.id, { type: "text-delta", text: "a" });
  convs.appendEvent(c.id, { type: "text-delta", text: "b" });
  expect(convs.listEvents(c.id).map((e: any) => e.text)).toEqual(["a", "b"]);
});

test("listEvents ignore une ligne corrompue et poursuit la lecture", () => {
  const c = convs.create({ projectId, provider: "claude", model: "opus", firstMessage: "x" });
  convs.appendEvent(c.id, { type: "text-delta", text: "avant" });
  db.query("INSERT INTO events (conversation_id, payload, created_at) VALUES (?, ?, ?)")
    .run(c.id, "{invalide", new Date().toISOString());
  convs.appendEvent(c.id, { type: "text-delta", text: "après" });
  const errors: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => errors.push(args);

  try {
    expect(convs.listEvents(c.id)).toEqual([
      { type: "text-delta", text: "avant" },
      { type: "text-delta", text: "après" },
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
