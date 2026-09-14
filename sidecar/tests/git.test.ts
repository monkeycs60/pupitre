import { beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { GitProjectService } from "../src/git";
import { ConversationStore } from "../src/stores/conversations";
import { ProjectStore } from "../src/stores/projects";

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
  expect(snapshot.headParents).toHaveLength(1);
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

test("produit un diff entre refs validées et refuse une référence invalide", async () => {
  const base = git("rev-parse", "HEAD");
  const head = commit("README.md", "base\nnext\n", "suite");

  const result = await gitView.diff(projectId, base, head);

  expect(result).toMatchObject({ base, head });
  expect(result.diff).toContain("+next");
  await expect(gitView.diff(projectId, "--output=/tmp/pwn", "HEAD"))
    .rejects.toThrow("référence Git invalide");
});

test("lit le HEAD et le diff du worktree demandé, pas ceux du dépôt principal", async () => {
  const mainHead = git("rev-parse", "HEAD");
  git("branch", "testcs");
  const worktree = join(repo, "..", "testcs-tree");
  git("worktree", "add", "-q", worktree, "testcs");
  writeFileSync(join(worktree, "only-testcs.ts"), "export const branch = true\n");
  const created = Bun.spawnSync(["git", "add", "."], { cwd: worktree });
  expect(created.exitCode).toBe(0);
  const committed = Bun.spawnSync(["git", "commit", "-qm", "testcs only"], { cwd: worktree });
  expect(committed.exitCode).toBe(0);
  const branchHead = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: worktree })
    .stdout.toString().trim();

  expect(gitView.snapshot(projectId, worktree)).toMatchObject({
    head: branchHead,
    currentBranch: "testcs",
    branchCommitShas: [branchHead],
    branchBase: "main",
  });
  expect(gitView.snapshot(projectId).head).toBe(mainHead);
  expect((await gitView.diff(projectId, mainHead, branchHead, worktree)).diff)
    .toContain("only-testcs.ts");
  expect(() => gitView.snapshot(projectId, join(repo, "..", "not-a-worktree")))
    .toThrow("worktree inconnu");
});

test("un dépôt neuf sans commit reste consultable", () => {
  const empty = join(repo, "..", "empty");
  mkdirSync(empty);
  const result = Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: empty });
  expect(result.exitCode).toBe(0);
  const project = projects.create({ name: "empty", path: empty });

  expect(gitView.snapshot(project.id)).toMatchObject({
    head: null,
    headParents: [],
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

test("ne tronque pas la provenance d'un tour initial dépassant 200 commits", () => {
  const empty = join(repo, "..", "initial-long");
  mkdirSync(empty);
  const run = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: empty });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  run("init", "-q", "-b", "main");
  run("config", "user.email", "long@example.test");
  run("config", "user.name", "Long Fixture");
  const project = projects.create({ name: "initial-long", path: empty });
  for (let index = 0; index < 205; index += 1) {
    run("commit", "--allow-empty", "-qm", `commit ${index}`);
  }

  const noisyHead = run("rev-parse", "HEAD");
  expect(gitView.commitsBetween(project.id, null, noisyHead)).toHaveLength(205);

  run("branch", "noisy", noisyHead);
  run("checkout", "-q", "noisy");
  run("branch", "-f", "main", `${noisyHead}~203`);
  run("checkout", "-q", "main");
  const snapshot = gitView.snapshot(project.id);
  expect(snapshot.commits.some((item) => item.sha === snapshot.head)).toBe(true);
  expect(snapshot.headParents).toEqual([run("rev-parse", "HEAD^")]);
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

function gitIn(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function linkOwner(sha: string): string | null {
  const row = db.query("SELECT conversation_id FROM commit_links WHERE commit_sha = ?").get(sha) as { conversation_id: string } | null;
  return row?.conversation_id ?? null;
}

test("rattache les commits d'un dépôt imbriqué et d'un worktree créé pendant le tour", () => {
  const nested = join(repo, "apps", "api");
  mkdirSync(nested, { recursive: true });
  gitIn(nested, "init", "-q", "-b", "main");
  gitIn(nested, "config", "user.email", "git@example.test");
  gitIn(nested, "config", "user.name", "Git Fixture");
  writeFileSync(join(nested, "base.ts"), "1\n");
  gitIn(nested, "add", "-A");
  gitIn(nested, "commit", "-qm", "base");
  const base = gitIn(nested, "rev-parse", "HEAD");

  const tracking = gitView.beginTurn(projectId, { cwd: repo });
  writeFileSync(join(nested, "api.ts"), "2\n");
  gitIn(nested, "add", "-A");
  gitIn(nested, "commit", "-qm", "api");
  const nestedCommit = gitIn(nested, "rev-parse", "HEAD");
  const worktree = join(repo, "..", "api-feature");
  gitIn(nested, "worktree", "add", "-q", "-b", "feature", worktree);
  writeFileSync(join(worktree, "feature.ts"), "3\n");
  gitIn(worktree, "add", "-A");
  gitIn(worktree, "commit", "-qm", "feature");
  const worktreeCommit = gitIn(worktree, "rev-parse", "HEAD");
  gitView.finishTurn(tracking, conversationId);

  expect(linkOwner(nestedCommit)).toBe(conversationId);
  expect(linkOwner(worktreeCommit)).toBe(conversationId);
  expect(linkOwner(base)).toBeNull();
  expect(gitView.commitMessage(projectId, worktreeCommit)).toBe("feature");
});

test("pendant des tours concurrents, rattache par worktree de la conversation ou par clé de ticket", () => {
  const ticketTree = join(repo, "..", "repo-tech4242");
  git("worktree", "add", "-q", "-b", "feature/TECH-4242", ticketTree);
  const other = conversations.create({ projectId, provider: "claude", model: "claude-opus-5", firstMessage: "autre" }).id;

  const mine = gitView.beginTurn(projectId, { cwd: ticketTree });
  const theirs = gitView.beginTurn(projectId, { cwd: repo });
  writeFileSync(join(ticketTree, "ticket.ts"), "1\n");
  gitIn(ticketTree, "add", "-A");
  gitIn(ticketTree, "commit", "-qm", "ticket");
  const ticketCommit = gitIn(ticketTree, "rev-parse", "HEAD");
  const rootCommit = commit("root.ts", "1\n", "racine");
  gitView.finishTurn(mine, conversationId);
  gitView.finishTurn(theirs, other);

  expect(linkOwner(ticketCommit)).toBe(conversationId);
  expect(linkOwner(rootCommit)).toBe(other);
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

test("expose le worktree vivant et commit seulement les fichiers sélectionnés", async () => {
  writeFileSync(join(repo, "tracked.ts"), "export const tracked = true\n");
  writeFileSync(join(repo, "untracked.ts"), "export const untracked = true\n");

  const snapshot = gitView.snapshot(projectId);
  expect(snapshot.dirtyFiles).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: "tracked.ts", status: "?" }),
    expect.objectContaining({ path: "untracked.ts", status: "?" }),
  ]));
  expect(snapshot.filePaths).toEqual(expect.arrayContaining(["tracked.ts", "untracked.ts"]));

  const diff = await gitView.workingTreeDiff(projectId);
  expect(diff.diff).toContain("untracked.ts");
  expect(gitView.file(projectId, "untracked.ts", "worktree")).toMatchObject({
    path: "untracked.ts",
    content: "export const untracked = true\n",
    readonly: false,
  });

  const committed = gitView.commit(projectId, null, ["untracked.ts"], "ajoute le fichier", conversationId);
  expect(committed.paths).toEqual(["untracked.ts"]);
  expect(git("show", "--format=%s", "--no-patch", committed.sha)).toBe("ajoute le fichier");
  expect(gitView.snapshot(projectId).dirtyFiles).toEqual([
    expect.objectContaining({ path: "tracked.ts", status: "?" }),
  ]);
  expect(gitView.snapshot(projectId).commits[0]?.conversations).toEqual([
    expect.objectContaining({ id: conversationId }),
  ]);
});

test("compte les commits liés par projet", () => {
  const first = commit("a.ts", "export const a = 1\n", "ajoute a");
  const second = commit("b.ts", "export const b = 1\n", "ajoute b");
  gitView.recordCommitLinks(projectId, conversationId, [first, second]);

  expect(gitView.linkedCommitCount(projectId)).toBe(2);
  expect(gitView.linkedCommitCount()).toBe(2);
  expect(gitView.linkedCommitCount("projet-inconnu")).toBe(0);
});

test("un push acquitté disparaît durablement de la conversation", () => {
  const pushed = commit("push.ts", "export const pushed = true\n", "push visible");
  git("update-ref", "refs/remotes/origin/main", pushed);
  gitView.recordCommitLinks(projectId, conversationId, [pushed]);

  expect(gitView.conversationPushes(projectId, conversationId).map((item) => item.sha)).toContain(pushed);

  gitView.acknowledgeConversationPush(projectId, conversationId, pushed);

  expect(gitView.conversationPushes(projectId, conversationId)).toEqual([]);
  expect(() => gitView.acknowledgeConversationPush(projectId, conversationId, "inconnu"))
    .toThrow("push inconnu");
});
