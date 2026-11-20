import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { ProjectStore } from "../src/stores/projects";
import { ensureShareProject } from "../src/share";

test("le projet Veille naît au premier partage puis reste le même", () => {
  const root = mkdtempSync(join(tmpdir(), "share-"));
  const db = openDb(root);
  try {
    const projects = new ProjectStore(db);
    const first = ensureShareProject(projects, root);
    expect(first.created).toBe(true);
    expect(first.project.name).toBe("Veille");
    expect(first.project.path).toBe(join(root, "veille"));
    expect(existsSync(join(root, "veille"))).toBe(true);

    projects.updateAppearance(first.project.id, { name: "Ma veille" });
    const second = ensureShareProject(projects, root);
    expect(second.created).toBe(false);
    expect(second.project.id).toBe(first.project.id);
    expect(projects.list().filter((project) => project.path === join(root, "veille"))).toHaveLength(1);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
