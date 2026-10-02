import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { ProjectStore } from "../src/stores/projects";
import { ConversationStore } from "../src/stores/conversations";
import { ProjectLaunchService } from "../src/project-launch";
import { PersonalEnvironments } from "../src/personal-environments";
import { applyPersonalProjectPresets } from "../src/personal-project-presets";

test("installe les réglages une seule fois, sans exécuter ni écraser une personnalisation", async () => {
  const root = mkdtempSync(join(tmpdir(), "personal-presets-")),
    db = openDb(root);
  const projects = new ProjectStore(db),
    launches = new ProjectLaunchService(db, projects, root);
  const environments = new PersonalEnvironments(
    db,
    projects,
    new ConversationStore(db),
    async () => {
      throw new Error("aucune sonde autorisée");
    },
  );
  try {
    const path = join(root, "helion");
    mkdirSync(path);
    const project = projects.create({ name: "helion", path });
    const custom = launches.save(project.id, {
      name: "Vérifier le projet",
      command: "echo personnalisé",
    });
    expect(
      applyPersonalProjectPresets(db, projects, launches, environments),
    ).toEqual({ projects: 1, commands: 1, environments: 1 });
    expect(launches.list(project.id)).toHaveLength(2);
    expect(launches.get(custom.id).command).toBe("echo personnalisé");
    expect(environments.list(project.id)[0]?.result).toBeNull();
    const generated = launches
      .list(project.id)
      .find((item) => item.id !== custom.id)!;
    launches.delete(generated.id);
    expect(
      applyPersonalProjectPresets(db, projects, launches, environments),
    ).toEqual({ projects: 0, commands: 0, environments: 0 });
    expect(launches.list(project.id)).toHaveLength(1);
  } finally {
    await launches.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
