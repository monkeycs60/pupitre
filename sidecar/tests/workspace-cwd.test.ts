import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { conversationCwd, projectCwd } from "../src/workspace";
import type { Conversation } from "../src/stores/conversations";
import type { Project } from "../src/stores/projects";

/**
 * Le worktree d'une conversation ne tient que si *tout* ce qu'elle lance s'y
 * exécute. Un seul `cwd: project.path` oublié suffit à faire travailler un
 * agent sur la mauvaise branche, en silence — et la prochaine fonctionnalité
 * qui lance un process rouvrirait le trou sans que rien ne le signale.
 */

const SRC = join(import.meta.dir, "../src");

function sourceFiles(dir: string): Array<{ path: string; text: string }> {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts")
      ? [{ path: path.slice(SRC.length + 1), text: readFileSync(path, "utf8") }]
      : [];
  });
}

test("aucun site ne fige son répertoire de travail sur le projet", () => {
  const offenders = sourceFiles(SRC)
    .filter((file) => file.path !== "workspace.ts")
    .flatMap((file) => file.text.split("\n").flatMap((line, index) =>
      /\bcwd:\s*project(Record)?\.path\b/.test(line)
        ? [`${file.path}:${index + 1}`]
        : []
    ));

  // Passe par conversationCwd(project, conversation) — ou, si le travail
  // n'appartient à aucune conversation, par projectCwd(project).
  expect(offenders).toEqual([]);
});

const project = { path: "/depot" } as Project;

test("une conversation sans worktree travaille dans le dépôt", () => {
  expect(conversationCwd(project, { worktree_path: null } as Conversation)).toBe("/depot");
  expect(conversationCwd(project, null)).toBe("/depot");
  expect(conversationCwd(project, undefined)).toBe("/depot");
});

test("une conversation avec worktree y travaille", () => {
  const conversation = { worktree_path: "/worktrees/p/ticket-42" } as Conversation;
  expect(conversationCwd(project, conversation)).toBe("/worktrees/p/ticket-42");
});

test("projectCwd reste le dépôt, quoi qu'il arrive", () => {
  expect(projectCwd(project)).toBe("/depot");
});
