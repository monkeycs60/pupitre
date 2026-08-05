import { beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { SkillInventory } from "../src/skills";
import { PresetStore } from "../src/stores/presets";
import { ProjectStore } from "../src/stores/projects";
import { WorkflowStore } from "../src/stores/workflows";

let db: Database;
let workflows: WorkflowStore;
let projectId: string;
let skillId: string;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "pupitre-workflows-"));
  const home = join(dir, "home");
  const projectPath = join(dir, "project");
  mkdirSync(projectPath, { recursive: true });
  const skillPath = join(home, ".claude/skills/support/SKILL.md");
  mkdirSync(join(home, ".claude/skills/support"), { recursive: true });
  writeFileSync(skillPath, "---\nname: support\ndescription: Répond aux tickets.\n---\n# Support\n");
  db = openDb(join(dir, "data"));
  const projects = new ProjectStore(db);
  projectId = projects.create({ name: "Demo", path: projectPath }).id;
  const inventory = new SkillInventory(db, projects, { homeDir: home });
  inventory.refresh();
  skillId = inventory.list()[0]!.id;
  new PresetStore(db);
  workflows = new WorkflowStore(db);
});

test("CRUD d'un workflow épinglé avec snapshot du skill et du modèle", () => {
  const created = workflows.create({
    projectId,
    name: "Réponse support",
    skillId,
    skillName: "support",
    skillInvocation: "support",
    prompt: "Prépare une réponse.",
    presetId: "builtin-speed",
    provider: "codex",
    model: "gpt-5.6-luna",
    effort: "low",
    speed: "fast",
    orchestrator: true,
  });
  expect(workflows.listByProject(projectId)).toEqual([created]);

  const updated = workflows.update(created.id, {
    projectId,
    name: "Support vérifié",
    skillId,
    skillName: "support",
    skillInvocation: "support",
    prompt: "Prépare puis relis la réponse.",
    presetId: null,
    provider: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
    speed: "standard",
    orchestrator: false,
  });
  expect(updated).toMatchObject({
    name: "Support vérifié",
    model: "gpt-5.6-sol",
    orchestrator: false,
  });
  expect(workflows.delete(created.id)).toBe(true);
  expect(workflows.listByProject(projectId)).toEqual([]);
});

test("refuse deux noms identiques dans un même projet", () => {
  const input = {
    projectId,
    name: "Support",
    skillId,
    skillName: "support",
    skillInvocation: "support",
    prompt: "Réponds.",
    presetId: null,
    provider: "claude" as const,
    model: "haiku",
    effort: "low",
    speed: null,
    orchestrator: true,
  };
  workflows.create(input);
  expect(() => workflows.create({ ...input, name: "support" })).toThrow();
});
