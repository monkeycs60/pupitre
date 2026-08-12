import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { GitProjectService } from "../src/git";
import { ConversationStore } from "../src/stores/conversations";
import { ProjectStore } from "../src/stores/projects";

/**
 * Cycle de vie des worktrees (ADR 0001) : une conversation peut naître sur sa
 * propre branche, dans un dossier que Pupitre crée et possède.
 */

let root: string;
let repo: string;
let db: Database;
let projects: ProjectStore;
let conversations: ConversationStore;
let git: GitProjectService;
let projectId: string;

function run(...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: repo });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pupitre-wt-"));
  repo = join(root, "repo");
  mkdirSync(repo);
  run("init", "-q", "-b", "main");
  run("config", "user.email", "git@example.test");
  run("config", "user.name", "Git Fixture");
  writeFileSync(join(repo, "README.md"), "base\n");
  run("add", "README.md");
  run("commit", "-qm", "socle");

  db = openDb(join(root, "data"));
  projects = new ProjectStore(db);
  conversations = new ConversationStore(db);
  projectId = projects.create({ name: "wt", path: repo }).id;
  git = new GitProjectService(db, projects, { worktreeRoot: join(root, "worktrees") });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("crée un worktree sur une branche neuve, hors du dépôt", () => {
  const created = git.createWorktree(projectId, { branch: "ticket-42" });

  expect(existsSync(created.path)).toBe(true);
  expect(created.branch).toBe("ticket-42");
  expect(created.path.startsWith(repo)).toBe(false);
  // Le dépôt principal reste sur sa branche.
  expect(run("rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  // Et git le connaît.
  expect(git.snapshot(projectId).worktrees.map((item) => item.branch)).toContain("ticket-42");
});

test("réutilise le worktree existant d'une branche plutôt que d'échouer", () => {
  const first = git.createWorktree(projectId, { branch: "ticket-42" });
  const second = git.createWorktree(projectId, { branch: "ticket-42" });

  expect(second.path).toBe(first.path);
});

test("s'attache à une branche déjà existante sans la recréer", () => {
  run("branch", "deja-la");
  const created = git.createWorktree(projectId, { branch: "deja-la" });

  expect(created.branch).toBe("deja-la");
});

test("refuse un nom de branche qui s'évaderait du dossier géré", () => {
  expect(() => git.createWorktree(projectId, { branch: "../evasion" })).toThrow();
  expect(() => git.createWorktree(projectId, { branch: "" })).toThrow();
});

test("retire un worktree et son dossier", () => {
  const created = git.createWorktree(projectId, { branch: "jetable" });
  git.removeWorktree(projectId, created.path);

  expect(existsSync(created.path)).toBe(false);
  expect(git.snapshot(projectId).worktrees.map((item) => item.path)).not.toContain(created.path);
});

test("ne retire jamais le dépôt principal", () => {
  expect(() => git.removeWorktree(projectId, repo)).toThrow(/principal/);
  expect(existsSync(join(repo, "README.md"))).toBe(true);
});

test("refuse de retirer un worktree encore porté par une conversation", () => {
  const created = git.createWorktree(projectId, { branch: "occupee" });
  conversations.create({
    projectId,
    provider: "codex",
    model: "gpt-5.6-luna",
    firstMessage: "travaille",
    worktreePath: created.path,
  });

  expect(() => git.removeWorktree(projectId, created.path)).toThrow(/conversation/);
  expect(existsSync(created.path)).toBe(true);
});

test("signale les worktrees fusionnés, dont la suppression est proposable", () => {
  const created = git.createWorktree(projectId, { branch: "fusionnee" });
  writeFileSync(join(created.path, "ajout.txt"), "x\n");
  const inWorktree = (...args: string[]): void => {
    const result = Bun.spawnSync(["git", ...args], { cwd: created.path });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  };
  inWorktree("add", "ajout.txt");
  inWorktree("commit", "-qm", "travail");
  run("merge", "--no-ff", "-q", "fusionnee", "-m", "fusion");

  const disposable = git.mergedWorktrees(projectId);
  expect(disposable.map((item) => item.path)).toContain(created.path);
});

test("ne propose pas la suppression d'un worktree non fusionné", () => {
  const created = git.createWorktree(projectId, { branch: "en-cours" });
  writeFileSync(join(created.path, "ajout.txt"), "x\n");
  const result = Bun.spawnSync(["git", "add", "ajout.txt"], { cwd: created.path });
  expect(result.exitCode).toBe(0);
  Bun.spawnSync(["git", "commit", "-qm", "travail"], { cwd: created.path });

  expect(git.mergedWorktrees(projectId).map((item) => item.path)).not.toContain(created.path);
});
