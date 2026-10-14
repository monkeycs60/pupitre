import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { ConversationStore } from "../src/stores/conversations";
import { ProjectStore } from "../src/stores/projects";
import { ReviewCommentStore } from "../src/stores/review-comments";

test("garde les brouillons de relecture d'une conversation, puis les marque envoyés", () => {
  const db = openDb(mkdtempSync(join(tmpdir(), "pupitre-review-")));
  const project = new ProjectStore(db).create({ name: "mono", path: "/tmp/mono-review" });
  const conversations = new ConversationStore(db);
  const conversation = conversations.create({ projectId: project.id, provider: "claude", model: "test", firstMessage: "Relire" });
  const store = new ReviewCommentStore(db);
  const anchor = { repositoryLabel: "hapigator", worktreePath: "/w/hapigator-t1", path: "lib/scope.js", side: "new" as const, lineText: "if (roles.some(isManager)) return ALL" };

  const first = store.create(conversation.id, { ...anchor, startLine: 44, endLine: 42, body: "Les AM aussi." });
  const second = store.create(conversation.id, { ...anchor, startLine: 10, endLine: 10, body: "Inutile ?" });
  expect([first.start_line, first.end_line, first.status]).toEqual([42, 44, "draft"]);

  expect(store.updateBody(second.id, "À supprimer.")?.body).toBe("À supprimer.");
  expect(store.delete(second.id)).toBe(true);

  expect(store.markSent(conversation.id).map((comment) => comment.body)).toEqual(["Les AM aussi."]);
  expect(store.list(conversation.id).map((comment) => [comment.status, comment.sent_at !== null])).toEqual([["sent", true]]);
  expect(store.updateBody(first.id, "trop tard")?.body).toBe("Les AM aussi.");
  expect(store.markSent(conversation.id)).toEqual([]);
});
