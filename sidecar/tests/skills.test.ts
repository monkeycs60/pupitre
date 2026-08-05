import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openDb } from "../src/db";
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
  projects: ProjectStore;
} {
  const dir = mkdtempSync(join(tmpdir(), "pupitre-skills-"));
  const home = join(dir, "home");
  const projectPath = join(dir, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(projectPath, { recursive: true });
  const db = openDb(join(dir, "data"));
  const projects = new ProjectStore(db);
  projects.create({ name: "Pupitre", path: projectPath });
  cleanups.push(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { db, dir, home, projectPath, projects };
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

test("indexe les skills Claude, plugins, prompts Codex et AGENTS.md avec leur provenance", () => {
  const { db, home, projectPath, projects } = fixture();
  write(join(home, ".claude/skills/global/SKILL.md"), `---
name: global-skill
description: Use when the user says "inspecte le projet".
triggers: [audit, inspection]
---
# Global
`);
  write(join(home, ".claude/plugins/marketplaces/demo/skills/plugin/SKILL.md"), `---
name: plugin-skill
description: Plugin de démonstration.
---
# Plugin
`);
  write(join(home, ".codex/prompts/review.md"), "# Review ciblée\n\nAnalyse le diff courant.");
  write(join(home, ".codex/AGENTS.md"), "# Consignes globales\n\nConventions communes.");
  write(join(projectPath, ".claude/skills/local/SKILL.md"), `---
name: local-skill
description: Skill du projet.
---
# Local
`);
  write(join(projectPath, "AGENTS.md"), "# Consignes Pupitre\n\nRègles du dépôt.");

  const inventory = new SkillInventory(db, projects, { homeDir: home });
  expect(inventory.refresh()).toBe(6);
  const project = projects.list()[0];
  if (!project) throw new Error("projet fixture absent");
  const skills = inventory.list({ projectId: project.id });

  expect(skills.map((skill) => skill.provenance)).toEqual([
    "agents-global",
    "agents-project",
    "claude-global",
    "claude-project",
    "claude-plugin",
    "codex-prompt",
  ]);
  const global = skills.find((skill) => skill.name === "global-skill");
  expect(global?.triggers).toContain("inspecte le projet");
  expect(global?.triggers).toContain("audit");
  expect(inventory.list({ provider: "codex", projectId: project.id })).toHaveLength(3);
  expect(inventory.list({ query: "démonstration", projectId: project.id })[0]?.name)
    .toBe("plugin-skill");
});

test("conserve un favori par projet et expose le contenu seulement au détail", () => {
  const { db, home, projects } = fixture();
  write(join(home, ".claude/skills/demo/SKILL.md"), `---
name: demo
description: Skill favori.
---
# Démonstration

Contenu complet.
`);
  const inventory = new SkillInventory(db, projects, { homeDir: home });
  inventory.refresh();
  const project = projects.list()[0];
  const skill = inventory.list()[0];
  if (!project || !skill) throw new Error("fixture incomplète");

  expect("content_md" in skill).toBe(false);
  expect(inventory.setFavorite(project.id, skill.id, true)).toBe(true);
  expect(inventory.list({ projectId: project.id })[0]?.favorite).toBe(true);
  expect(inventory.list({ favoriteProjectId: project.id })[0]?.favorite).toBe(true);
  expect(inventory.get(skill.id, project.id)?.content_md).toContain("Contenu complet");
  expect(inventory.setFavorite(project.id, skill.id, false)).toBe(true);
  expect(inventory.list({ projectId: project.id })[0]?.favorite).toBe(false);
});

test("le watcher réindexe une modification de SKILL.md", async () => {
  const { db, home, projects } = fixture();
  const path = join(home, ".claude/skills/watch/SKILL.md");
  write(path, `---
name: watched
description: Avant modification.
---
# Watched
`);
  const inventory = new SkillInventory(db, projects, {
    homeDir: home,
    watchDebounceMs: 20,
  });
  cleanups.push(() => inventory.stop());
  inventory.start();

  write(path, `---
name: watched
description: Après modification.
---
# Watched
`);
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (inventory.list()[0]?.description === "Après modification.") return;
    await Bun.sleep(20);
  }
  expect(inventory.list()[0]?.description).toBe("Après modification.");
});

test("le watcher ignore les liens cassés à la racine du dossier personnel", async () => {
  const { db, home, projects } = fixture();
  symlinkSync(join(home, "cible-absente"), join(home, ".lien-casse"));
  const inventory = new SkillInventory(db, projects, {
    homeDir: home,
    watchDebounceMs: 20,
  });
  cleanups.push(() => inventory.stop());

  inventory.start();
  write(join(home, "fichier-sans-rapport.txt"), "déclencheur");
  await Bun.sleep(50);

  expect(inventory.list()).toEqual([]);
});

test("le pont résout la même invocation pour un skill Claude et un prompt Codex", () => {
  const { db, home, projectPath, projects } = fixture();
  write(join(home, ".claude/skills/audit/SKILL.md"), `---
name: audit-local
description: Audite le code.
---
# Audit Claude

Vérifie les invariants métier.
`);
  write(join(home, ".codex/prompts/review.md"), `# Review Codex

Relis chaque changement avant de conclure.
`);
  write(join(projectPath, ".claude/skills/audit/SKILL.md"), `---
name: audit-local
description: Audite ce projet.
---
# Audit projet

Applique les conventions du dépôt.
`);
  const inventory = new SkillInventory(db, projects, { homeDir: home });
  inventory.refresh();
  const project = projects.list()[0];
  if (!project) throw new Error("projet fixture absent");

  const forCodex = inventory.augmentPrompt("$audit-local inspecte ce diff", project.id);
  expect(forCodex).toContain("# Audit projet");
  expect(forCodex).not.toContain("Vérifie les invariants métier");
  expect(forCodex).toContain("$audit-local inspecte ce diff");

  const forClaude = inventory.augmentPrompt("Lance $review", project.id);
  expect(forClaude).toContain("Relis chaque changement avant de conclure.");
  expect(inventory.augmentPrompt("$inconnu reste intact", project.id))
    .toBe("$inconnu reste intact");
});

test("lit les descriptions et triggers YAML multilignes", () => {
  const { db, home, projects } = fixture();
  write(join(home, ".claude/skills/multiligne/SKILL.md"), [
    "---\r",
    "name: multiligne\r",
    "description: >\r",
    "  Use when a demande\r",
    "  spans several lines.\r",
    "triggers:\r",
    "  - demande longue\r",
    "  - plusieurs lignes\r",
    "---\r",
    "# Multiligne\r",
  ].join("\n"));
  const inventory = new SkillInventory(db, projects, { homeDir: home });
  inventory.refresh();

  expect(inventory.list()[0]).toMatchObject({
    description: "Use when a demande spans several lines.",
    triggers: expect.arrayContaining(["demande longue", "plusieurs lignes"]),
  });
});
