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
  const cleanReview = store.create({
    projectId,
    conversationId,
    gitRefBase: "HEAD^",
    gitRefHead: head,
    provider: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
  });
  store.complete(cleanReview.id, []);

  expect(gitView.snapshot(projectId).commits[0]?.guardian).toEqual(expect.arrayContaining([
    { reviewId: review.id, red: 1, orange: 0, grey: 0 },
    { reviewId: cleanReview.id, red: 0, orange: 0, grey: 0 },
  ]));
});

test("produit un diff entre refs validées et refuse une référence invalide", async () => {
  const base = git("rev-parse", "HEAD");
  const head = commit("README.md", "base\nnext\n", "suite");

  const result = await gitView.diff(projectId, base, head);

  expect(result).toMatchObject({ base, head });
  expect(result.diff).toContain("+next");
  await expect(gitView.diff(projectId, "--output=/tmp/pwn", "HEAD"))
    .rejects.toThrow("référence Git invalide");
});

test("un dépôt neuf sans commit reste consultable", () => {
  const empty = join(repo, "..", "empty");
  mkdirSync(empty);
  const result = Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: empty });
  expect(result.exitCode).toBe(0);
  const project = projects.create({ name: "empty", path: empty });

  expect(gitView.snapshot(project.id)).toMatchObject({
    head: null,
    currentBranch: "main",
    commits: [],
  });
});

test("attribue tous les commits initiaux créés depuis un dépôt vide", () => {
  const empty = join(repo, "..", "initial");
  mkdirSync(empty);
  const run = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: empty });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  run("init", "-q", "-b", "main");
  run("config", "user.email", "empty@example.test");
  run("config", "user.name", "Empty Fixture");
  const project = projects.create({ name: "initial", path: empty });
  writeFileSync(join(empty, "one"), "1");
  run("add", "."); run("commit", "-qm", "one");
  const one = run("rev-parse", "HEAD");
  writeFileSync(join(empty, "two"), "2");
  run("add", "."); run("commit", "-qm", "two");
  const two = run("rev-parse", "HEAD");

  expect(gitView.commitsBetween(project.id, null, two)).toEqual([one, two]);
});

test("ne prétend pas attribuer des commits pendant deux tours concurrents", () => {
  const first = gitView.beginTurn(projectId);
  const second = gitView.beginTurn(projectId);
  const sha = commit("concurrent.ts", "true\n", "concurrent");

  gitView.finishTurn(first, conversationId);
  gitView.finishTurn(second, conversationId);

  expect(gitView.snapshot(projectId).commits.find((item) => item.sha === sha)?.conversations)
    .toEqual([]);
});

test("un sujet contenant les anciens séparateurs de parsing reste intact", () => {
  writeFileSync(join(repo, "separator.txt"), "ok\n");
  git("add", ".");
  git("commit", "-qm", "avant\u001eentre\u001faprès");

  expect(gitView.snapshot(projectId).commits[0]?.subject)
    .toBe("avant\u001eentre\u001faprès");
});

test("interrompt un diff avant de tamponner plus de deux mégaoctets", async () => {
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "large.txt"), `${"x".repeat(2_200_000)}\n`);
  git("add", ".");
  git("commit", "-qm", "large");

  await expect(gitView.diff(projectId, base, "HEAD"))
    .rejects.toThrow("sortie Git trop volumineuse");
});

test("détecte seulement les nouveaux commits quand HEAD avance", () => {
  const before = gitView.head(projectId)!;
  const first = commit("one.ts", "1\n", "un");
  const second = commit("two.ts", "2\n", "deux");

  expect(gitView.commitsBetween(projectId, before, gitView.head(projectId)!))
    .toEqual([first, second]);
});
