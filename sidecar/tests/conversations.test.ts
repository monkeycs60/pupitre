import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { ProjectStore } from "../src/stores/projects";
import { ConversationStore } from "../src/stores/conversations";

let convs: ConversationStore;
let projectId: string;
beforeEach(() => {
  const db = openDb(mkdtempSync(join(tmpdir(), "pupitre-test-")));
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

test("setCliSessionId persiste pour la reprise", () => {
  const c = convs.create({ projectId, provider: "codex", model: "gpt-5.6-luna", firstMessage: "x" });
  convs.setCliSessionId(c.id, "abc-123");
  expect(convs.get(c.id)!.cli_session_id).toBe("abc-123");
});
