import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { ConversationStore } from "../src/stores/conversations";
import { PresetStore } from "../src/stores/presets";
import { ProjectStore } from "../src/stores/projects";
import { SettingsStore, SOL_61_MIGRATION_KEY } from "../src/stores/settings";

test("remplace les choix sauvegardés de GPT-6 Sol par GPT-6.1 Sol high", () => {
  const dir = mkdtempSync(join(tmpdir(), "pupitre-sol-61-"));
  const db = openDb(dir);
  const projectStore = new ProjectStore(db);
  const project = projectStore.create({ name: "Pupitre", path: dir });
  const preset = new PresetStore(db).create({
    name: "Ancien Sol", provider: "codex", model: "gpt-6-sol", effort: "xhigh", speed: "fast",
  });
  const conversation = new ConversationStore(db).create({
    projectId: project.id, provider: "codex", model: "gpt-6-sol", effort: "medium",
    firstMessage: "Continuer cette conversation",
  });
  const now = new Date().toISOString();
  db.query(`INSERT INTO workflows
    (id, project_id, name, skill_name, skill_invocation, prompt, provider, model, effort, created_at, updated_at)
    VALUES ('workflow-sol', ?, 'Relecture', '', '', '', 'codex', 'gpt-6-sol', 'xhigh', ?, ?)`)
    .run(project.id, now, now);
  db.query(`INSERT INTO routines
    (id, project_id, name, schedule, provider, model, effort, created_at, updated_at)
    VALUES ('routine-sol', ?, 'Relecture quotidienne', '0 9 * * *', 'codex', 'gpt-6-sol', 'low', ?, ?)`)
    .run(project.id, now, now);
  db.query(`INSERT INTO subtasks
    (id, conversation_id, provider, model, effort, prompt, created_at, updated_at)
    VALUES ('subtask-sol', ?, 'codex', 'gpt-6-sol', 'xhigh', 'Relire', ?, ?)`)
    .run(conversation.id, now, now);
  projectStore.setLaunchConfig(project.id, "default", { provider: "codex", model: "gpt-6-sol", effort: "xhigh", speed: "fast" });
  projectStore.setLaunchConfig(project.id, "scout", { provider: "codex", model: "gpt-6-luna", effort: "xhigh", speed: "standard" });
  projectStore.setLaunchConfig(project.id, "todo", { provider: "codex", model: "gpt-6-sol", effort: "low", speed: "standard" });
  new SettingsStore(db).set("ticketAuditConfig", { provider: "codex", model: "gpt-6-sol", effort: "xhigh", speed: "standard" });
  db.query("DELETE FROM settings WHERE key = ?").run(SOL_61_MIGRATION_KEY);
  db.close();

  const migrated = openDb(dir);
  for (const table of ["presets", "workflows", "routines", "conversations", "subtasks"]) {
    expect(migrated.query(`SELECT model, effort FROM ${table} WHERE model = 'gpt-6-sol'`).all()).toEqual([]);
  }
  expect(new PresetStore(migrated).get(preset.id)).toMatchObject({ model: "gpt-6.1-sol", effort: "high" });
  expect(new ConversationStore(migrated).get(conversation.id)).toMatchObject({ model: "gpt-6.1-sol", effort: "high" });
  for (const table of ["workflows", "routines", "subtasks"]) {
    expect(migrated.query(`SELECT model, effort FROM ${table} WHERE id = ?`).get(`${table.slice(0, -1)}-sol`))
      .toEqual({ model: "gpt-6.1-sol", effort: "high" });
  }
  const configs = new ProjectStore(migrated).get(project.id)!;
  expect(configs.default_launch_config).toEqual({ provider: "codex", model: "gpt-6.1-sol", effort: "high", speed: "fast" });
  expect(configs.scout_launch_config).toEqual({ provider: "codex", model: "gpt-6-luna", effort: "xhigh", speed: "standard" });
  expect(configs.todo_launch_config).toEqual({ provider: "codex", model: "gpt-6.1-sol", effort: "high", speed: "standard" });
  expect(new SettingsStore(migrated).get<Record<string, unknown>>("ticketAuditConfig")).toEqual({
    provider: "codex", model: "gpt-6.1-sol", effort: "high", speed: "standard",
  });
  expect(new SettingsStore(migrated).all()).not.toHaveProperty(SOL_61_MIGRATION_KEY);
  migrated.close();

  const reopened = openDb(dir);
  expect(new SettingsStore(reopened).get<boolean>(SOL_61_MIGRATION_KEY)).toBe(true);
  expect(new ProjectStore(reopened).get(project.id)?.default_launch_config?.model).toBe("gpt-6.1-sol");
  reopened.close();
});
