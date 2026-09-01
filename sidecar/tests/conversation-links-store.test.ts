import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { ConversationLinkStore } from "../src/stores/conversation-links";
import { ConversationStore } from "../src/stores/conversations";
import { ProjectStore } from "../src/stores/projects";

test("relie deux conversations indépendantes sans cascade latérale", () => {
  const db = openDb(mkdtempSync(join(tmpdir(), "pupitre-sidequest-links-")));
  const project = new ProjectStore(db).create({ name: "Pupitre", path: `/tmp/pupitre-${crypto.randomUUID()}` });
  const conversations = new ConversationStore(db);
  const source = conversations.create({ projectId: project.id, provider: "codex", model: "gpt-5.6", firstMessage: "Source" });
  const target = conversations.create({ projectId: project.id, provider: "codex", model: "gpt-5.6", firstMessage: "Sidequest" });
  const links = new ConversationLinkStore(db);
  links.createSidequest({ sourceConversationId: source.id, targetConversationId: target.id, label: "Analyser" });
  expect(links.byTarget(target.id)?.source_conversation_id).toBe(source.id);
  conversations.setArchived(source.id, true);
  expect(conversations.get(target.id)?.archived).toBeFalse();
});
