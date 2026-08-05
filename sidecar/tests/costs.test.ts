import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CostStore } from "../src/costs";
import { openDb } from "../src/db";
import { ConversationStore } from "../src/stores/conversations";
import { ProjectStore } from "../src/stores/projects";
import { SubtaskStore } from "../src/subtasks";

test("agrège les tokens par modèle et les tokens parent préservés par Luna", () => {
  const dir = mkdtempSync(join(tmpdir(), "pupitre-costs-"));
  const db = openDb(dir);
  const projects = new ProjectStore(db);
  const conversations = new ConversationStore(db);
  const project = projects.create({ name: "Coûts", path: dir });
  const conversation = conversations.create({
    projectId: project.id,
    provider: "claude",
    model: "fable-5",
    firstMessage: "Mesure",
  });
  conversations.appendEvent(conversation.id, {
    type: "session", provider: "claude", cliSessionId: "session", model: "fable-5",
  });
  conversations.appendEvent(conversation.id, { type: "usage", inputTokens: 100, outputTokens: 20 });
  const subtask = new SubtaskStore(db).create({
    conversationId: conversation.id,
    provider: "codex",
    model: "gpt-5.6-luna",
    prompt: "Délègue",
  });
  conversations.appendEvent(subtask.id, {
    type: "session", provider: "codex", cliSessionId: "thread", model: "gpt-5.6-luna",
  });
  conversations.appendEvent(subtask.id, { type: "usage", inputTokens: 40, outputTokens: 10 });
  // Un changement ultérieur ne réécrit pas le contrefactuel de la délégation.
  conversations.updateModel(conversation.id, {
    model: "gpt-5.6-luna", effort: "low", speed: "fast",
  });

  const report = new CostStore(db).projectMonth(project.id, new Date().toISOString().slice(0, 7));

  expect(report).toMatchObject({
    totalTokens: 170,
    directTokens: 120,
    subtaskTokens: 50,
    delegationSavingsTokens: 50,
  });
  expect(report.conversations[0]?.models).toEqual([
    { model: "fable-5", tokens: 120 },
    { model: "gpt-5.6-luna", tokens: 50 },
  ]);
});
