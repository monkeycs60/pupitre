import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Project, ProjectStore } from "./stores/projects";

export const SHARE_PROJECT_NAME = "Veille";

export function ensureShareProject(projects: ProjectStore, dataDir: string): { project: Project; created: boolean } {
  const path = join(dataDir, "veille");
  mkdirSync(path, { recursive: true });
  const existing = projects.list().find((project) => project.path === path);
  if (existing) return { project: existing, created: false };
  return { project: projects.create({ name: SHARE_PROJECT_NAME, path }), created: true };
}
