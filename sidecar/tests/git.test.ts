import { beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { GitProjectService } from "../src/git";
import { ConversationStore } from "../src/stores/conversations";
import { ProjectStore } from "../src/stores/projects";
import { ReviewStore } from "../src/stores/reviews";

let db: Database;
let repo: string;
let projects: ProjectStore;
let conversations: ConversationStore;
let gitView: GitProjectService;
let projectId: string;
let conversationId: string;

function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: repo });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function commit(file: string, content: string, message: string): string {
  writeFileSync(join(repo, file), content);
  git("add", file);
  git("commit", "-qm", message);
  return git("rev-parse", "HEAD");
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "pupitre-git-"));
  repo = join(dir, "repo");
  mkdirSync(repo);
  git("init", "-q", "-b", "main");
  git("config", "user.email", "git@example.test");
  git("config", "user.name", "Git Fixture");
  commit("README.md", "base\n", "socle");

  db = openDb(join(dir, "data"));
  projects = new ProjectStore(db);
  conversations = new ConversationStore(db);
  projectId = projects.create({ name: "git", path: repo }).id;
  conversationId = conversations.create({
    projectId,
    provider: "codex",
    model: "gpt-5.6-luna",
    firstMessage: "travaille",
  }).id;
  gitView = new GitProjectService(db, projects);
});

test("retourne commits, branches, HEAD, worktrees et conversations d'origine", () => {
  const linked = commit("src.ts", "export const value = 1\n", "ajoute value");
  gitView.recordCommitLinks(projectId, conversationId, [linked]);

  const worktree = join(repo, "..", "feature-tree");
  git("branch", "feature");
  git("worktree", "add", "-q", worktree, "feature");

  const snapshot = gitView.snapshot(projectId);

  expect(snapshot.head).toBe(linked);
  expect(snapshot.currentBranch).toBe("main");
  expect(snapshot.commits[0]).toMatchObject({
    sha: linked,
    subject: "ajoute value",
    conversations: [expect.objectContaining({ id: conversationId })],
  });
  expect(snapshot.branches).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "main", current: true }),
    expect.objectContaining({ name: "feature", current: false }),
  ]));
  expect(snapshot.worktrees.map((item) => item.path)).toContain(worktree);
});

test("ancre les flags Gardien sur le commit visé par la review", () => {
  const head = commit("danger.ts", "export const secret = true\n", "risque");
  const store = new ReviewStore(db);
  const review = store.create({
    projectId,
    conversationId,
    gitRefBase: "HEAD^",
    gitRefHead: head,
    provider: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
  });
  store.complete(review.id, [{
    file: "danger.ts",
    line_start: 1,
    line_end: 1,
    severity: "red",
    category: "secret",
    message: "Ne pas exposer ce secret.",
  }]);

  expect(gitView.snapshot(projectId).commits[0]?.guardian).toEqual({
    reviewIds: [review.id],
    red: 1,
    orange: 0,
    grey: 0,
  });
});

test("produit un diff entre refs validées et refuse une référence invalide", () => {
  const base = git("rev-parse", "HEAD");
  const head = commit("README.md", "base\nnext\n", "suite");

  const result = gitView.diff(projectId, base, head);

  expect(result).toMatchObject({ base, head });
  expect(result.diff).toContain("+next");
  expect(() => gitView.diff(projectId, "--output=/tmp/pwn", "HEAD"))
    .toThrow("référence Git invalide");
});

test("détecte seulement les nouveaux commits quand HEAD avance", () => {
  const before = gitView.head(projectId)!;
  const first = commit("one.ts", "1\n", "un");
  const second = commit("two.ts", "2\n", "deux");

  expect(gitView.commitsBetween(projectId, before, gitView.head(projectId)!))
    .toEqual([first, second]);
});
