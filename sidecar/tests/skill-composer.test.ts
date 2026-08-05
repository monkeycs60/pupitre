import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openDb } from "../src/db";
import { QuotaTracker } from "../src/quotas";
import { SkillAlreadyExistsError, SkillComposer } from "../src/skill-composer";
import { SkillInventory } from "../src/skills";
import { ProjectStore } from "../src/stores/projects";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function fixture(): {
  db: Database;
  dir: string;
  home: string;
  projectPath: string;
  projectId: string;
  projects: ProjectStore;
  inventory: SkillInventory;
} {
  const dir = mkdtempSync(join(tmpdir(), "pupitre-skill-composer-"));
  const home = join(dir, "home");
  const projectPath = join(dir, "project");
  mkdirSync(projectPath, { recursive: true });
  const creatorPath = join(home, ".claude/skills/skill-creator/SKILL.md");
  mkdirSync(dirname(creatorPath), { recursive: true });
  writeFileSync(creatorPath, `---
name: skill-creator
description: Cadre de création de skills.
---
# Skill Creator

Écris des étapes vérifiables.
`);
  const db = openDb(join(dir, "data"));
  const projects = new ProjectStore(db);
  const projectId = projects.create({ name: "Demo", path: projectPath }).id;
  const inventory = new SkillInventory(db, projects, { homeDir: home });
  inventory.refresh();
  cleanups.push(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { db, dir, home, projectPath, projectId, projects, inventory };
}

test("compose un SKILL.md projet avec skill-creator puis l'indexe", async () => {
  const { db, projectPath, projectId, projects, inventory } = fixture();
  let generationPrompt = "";
  const composer = new SkillComposer(inventory, projects, new QuotaTracker(db), {
    generator: async ({ prompt }) => {
      generationPrompt = prompt;
      return JSON.stringify({
        name: "Réponse Ticket",
        description: "Use when a support ticket needs a precise answer.",
        content: "---\nname: unsafe-name\n---\n# Réponse ticket\n\n1. Lire le ticket.",
      });
    },
  });

  const skill = await composer.compose({
    projectId,
    description: "Répondre aux tickets support",
    scope: "project",
  });

  expect(generationPrompt).toContain("Écris des étapes vérifiables.");
  expect(skill).toMatchObject({
    name: "reponse-ticket",
    invocation: "reponse-ticket",
    provenance: "claude-project",
    project_id: projectId,
  });
  const content = readFileSync(
    join(projectPath, ".claude/skills/reponse-ticket/SKILL.md"),
    "utf8",
  );
  expect(content).toContain("name: reponse-ticket");
  expect(content).not.toContain("unsafe-name");
  await expect(composer.compose({
    projectId,
    description: "Même besoin",
    scope: "project",
  })).rejects.toBeInstanceOf(SkillAlreadyExistsError);
});

test("refuse une sortie modèle invalide avant toute écriture", async () => {
  const { db, home, projectId, projects, inventory } = fixture();
  const composer = new SkillComposer(inventory, projects, new QuotaTracker(db), {
    homeDir: home,
    generator: async () => "pas du json",
  });

  await expect(composer.compose({
    projectId,
    description: "Créer quelque chose",
    scope: "global",
  })).rejects.toThrow(/JSON valide/);
  expect(inventory.list().map((skill) => skill.name)).toEqual(["skill-creator"]);
});
