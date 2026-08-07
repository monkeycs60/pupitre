import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../src/db";
import { GamificationService, ACTIVE_STEP_MS, MAX_ACTIVE_STEPS, focusMultiplier } from "../src/gamification";
import { GitProjectService } from "../src/git";
import { ConversationStore } from "../src/stores/conversations";
import { ProjectStore } from "../src/stores/projects";

function today(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

test("le bonus de focus progresse par tranche de dix minutes et plafonne à 5,29", () => {
  expect(focusMultiplier(0)).toBe(1);
  expect(focusMultiplier(ACTIVE_STEP_MS)).toBe(1.03);
  expect(focusMultiplier(ACTIVE_STEP_MS * MAX_ACTIVE_STEPS)).toBe(5.29);
  expect(focusMultiplier(ACTIVE_STEP_MS * (MAX_ACTIVE_STEPS + 10))).toBe(5.29);
});

test("les tokens donnent de l'XP une seule fois et le suivi actif reste journalier", () => {
  const dir = mkdtempSync(join(tmpdir(), "pupitre-gamification-"));
  const db = openDb(dir);
  try {
    const projects = new ProjectStore(db);
    const project = projects.create({ name: "Test", path: dir });
    const conversations = new ConversationStore(db);
    const conversation = conversations.create({
      projectId: project.id,
      provider: "codex",
      model: "gpt-5.6-sol",
      firstMessage: "Ajouter une feature API",
    });
    conversations.appendEvent(conversation.id, {
      type: "user-message", text: "Ajouter une feature API", images: [],
    });
    conversations.appendEvent(conversation.id, { type: "status", state: "running" });
    conversations.appendEvent(conversation.id, { type: "usage", inputTokens: 5_000, outputTokens: 1_000 });
    const service = new GamificationService(db, projects, new GitProjectService(db, projects));
    const first = service.snapshot();
    expect(first.xp).toBe(0);
    conversations.appendEvent(conversation.id, { type: "status", state: "done" });
    const completed = service.snapshot();
    expect(completed.xp).toBeGreaterThan(0);
    expect(service.snapshot().xp).toBe(completed.xp);
    for (let index = 0; index < 10; index += 1) service.addActiveTime(today(), 60_000);
    expect(service.snapshot().focusMultiplier).toBe(1.03);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
