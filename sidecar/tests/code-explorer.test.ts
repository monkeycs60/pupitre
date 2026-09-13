import { beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodeExplorerService } from "../src/code-explorer";
import { openDb } from "../src/db";
import { GitProjectService } from "../src/git";
import { ConversationStore } from "../src/stores/conversations";
import { ProjectStore } from "../src/stores/projects";

let db: Database;
let root: string;
let repo: string;
let explorer: CodeExplorerService;
let projectId: string;
let conversationId: string;

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function initRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  git(path, "init", "-q", "-b", "main");
  git(path, "config", "user.email", "git@example.test");
  git(path, "config", "user.name", "Git Fixture");
}

function commit(cwd: string, file: string, content: string, message: string): string {
  mkdirSync(join(cwd, file, ".."), { recursive: true });
  writeFileSync(join(cwd, file), content);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-qm", message);
  return git(cwd, "rev-parse", "HEAD");
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pupitre-code-")));
  repo = join(root, "mono");
  initRepo(repo);
  writeFileSync(join(repo, ".gitignore"), "apps/api/\n");
  commit(repo, "README.md", "mono\n", "socle");

  db = openDb(join(root, "data"));
  const projects = new ProjectStore(db);
  const conversations = new ConversationStore(db);
  projectId = projects.create({ name: "mono", path: repo }).id;
  conversationId = conversations.create({
    projectId,
    provider: "claude",
    model: "claude-opus-5",
    firstMessage: "travaille",
  }).id;
  explorer = new CodeExplorerService(db, projects);
  new GitProjectService(db, projects);
});

test("liste le dépôt racine, les dépôts imbriqués et leurs worktrees avec les conversations", async () => {
  const api = join(repo, "apps", "api");
  initRepo(api);
  commit(api, "src/index.ts", "export {}\n", "api");
  const worktree = join(root, "api-feature");
  git(api, "worktree", "add", "-q", "-b", "feature", worktree);
  db.query("UPDATE conversations SET worktree_path = ? WHERE id = ?").run(worktree, conversationId);

  const sources = await explorer.sources(projectId);

  expect(sources.map((source) => [source.repositoryLabel, source.branch, source.main])).toEqual([
    ["mono", "main", true],
    ["apps/api", "main", true],
    ["apps/api", "feature", false],
  ]);
  expect(sources[2]).toMatchObject({
    path: worktree,
    repositoryPath: api,
    conversations: [{ id: conversationId, title: expect.any(String), provider: "claude" }],
  });
});

test("liste les fichiers suivis et non suivis, avec leur état modifié", async () => {
  commit(repo, "src/app.ts", "export const a = 1\n", "app");
  writeFileSync(join(repo, "src/app.ts"), "export const a = 2\n");
  writeFileSync(join(repo, "notes.md"), "brouillon\n");

  const files = await explorer.files(projectId, repo);

  expect(files.paths).toEqual([".gitignore", "notes.md", "README.md", "src/app.ts"]);
  expect(files.dirty).toEqual(expect.arrayContaining([
    { path: "src/app.ts", status: "M" },
    { path: "notes.md", status: "?" },
  ]));
  expect(files.truncated).toBe(false);
});

test("lit un fichier du worktree ou d'un commit, et signale un binaire", async () => {
  const first = commit(repo, "src/app.ts", "v1\n", "v1");
  writeFileSync(join(repo, "src/app.ts"), "v2\n");
  writeFileSync(join(repo, "logo.bin"), Buffer.from([0x89, 0x00, 0x01]));

  expect(await explorer.file(projectId, repo, "src/app.ts")).toMatchObject({ content: "v2\n", binary: false });
  expect(await explorer.file(projectId, repo, "src/app.ts", first)).toMatchObject({ content: "v1\n", ref: first });
  expect(await explorer.file(projectId, repo, "logo.bin")).toMatchObject({ content: null, binary: true });
});

test("regroupe le blame par commit, rattache la conversation et marque les lignes non commitées", async () => {
  const base = commit(repo, "src/app.ts", "a\nb\n", "base");
  const linked = commit(repo, "src/app.ts", "a\nb\nc\nd\n", "ajoute c et d");
  db.query("INSERT INTO commit_links (commit_sha, project_id, conversation_id, created_at) VALUES (?, ?, ?, ?)")
    .run(linked, projectId, conversationId, new Date().toISOString());
  writeFileSync(join(repo, "src/app.ts"), "a\nb\nc\nd\ne\n");

  const blame = await explorer.blame(projectId, repo, "src/app.ts");

  expect(blame.lineCount).toBe(5);
  expect(blame.groups.map((group) => [group.sha, group.start, group.count, group.uncommitted])).toEqual([
    [base, 1, 2, false],
    [linked, 3, 2, false],
    ["0".repeat(40), 5, 1, true],
  ]);
  expect(blame.groups[1]).toMatchObject({
    author: "Git Fixture",
    summary: "ajoute c et d",
    conversations: [{ id: conversationId, provider: "claude" }],
  });
});

test("un fichier jamais commité se lit comme un seul bloc non commité", async () => {
  writeFileSync(join(repo, "draft.ts"), "x\ny\n");

  const blame = await explorer.blame(projectId, repo, "draft.ts");

  expect(blame.groups).toHaveLength(1);
  expect(blame.groups[0]).toMatchObject({ uncommitted: true, start: 1 });
});

test("suit l'historique d'un fichier à travers un renommage", async () => {
  const created = commit(repo, "old.ts", "export const value = 1\n", "crée old");
  renameSync(join(repo, "old.ts"), join(repo, "new.ts"));
  const renamed = commit(repo, "new.ts", "export const value = 1\n", "renomme");

  const history = await explorer.history(projectId, repo, "new.ts");

  expect(history.map((item) => item.sha)).toEqual([renamed, created]);
});

test("pagine le graphe et isole les commits propres à la branche du worktree", async () => {
  const worktree = join(root, "feature");
  git(repo, "worktree", "add", "-q", "-b", "feature", worktree);
  const own = commit(worktree, "feature.ts", "1\n", "feature");
  commit(repo, "main.ts", "1\n", "main avance");
  explorer = new CodeExplorerService(db, new ProjectStore(db));

  const graph = await explorer.graph(projectId, worktree);

  expect(graph).toMatchObject({ head: own, currentBranch: "feature", base: "main", focus: [own], skip: 0, hasMore: false });
  expect(graph.commits).toHaveLength(3);
  expect(graph.commits.every((item) => item.parents.length <= 1)).toBe(true);
  const next = await explorer.graph(projectId, worktree, 2);
  expect(next.commits).toHaveLength(1);
  expect(next.focus).toEqual([]);
});

test("détaille un commit avec ses fichiers, renommages compris, et son diff par fichier", async () => {
  commit(repo, "src/a.ts", "export const a = 1\n".repeat(5), "base");
  git(repo, "mv", "src/a.ts", "src/b.ts");
  writeFileSync(join(repo, "src/c.ts"), "nouveau\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "renomme a\n\nCorps du message.");
  const sha = git(repo, "rev-parse", "HEAD");

  const detail = await explorer.commit(projectId, repo, sha.slice(0, 10));

  expect(detail).toMatchObject({ sha, subject: "renomme a", body: "Corps du message.", author: "Git Fixture" });
  expect(detail.files).toEqual(expect.arrayContaining([
    { path: "src/b.ts", previousPath: "src/a.ts", status: "R", added: 0, removed: 0 },
    { path: "src/c.ts", previousPath: null, status: "A", added: 1, removed: 0 },
  ]));
  const { diff } = await explorer.diff(projectId, repo, sha, "src/c.ts");
  expect(diff).toContain("+nouveau");
});

test("détaille le commit racine", async () => {
  const [first] = (await explorer.graph(projectId, repo)).commits.slice(-1);

  const detail = await explorer.commit(projectId, repo, first!.sha);

  expect(detail.parents).toEqual([]);
  expect(detail.files.map((file) => file.path)).toEqual([".gitignore", "README.md"]);
});

test("cherche du texte dans les fichiers suivis et non suivis", async () => {
  commit(repo, "src/app.ts", "const Needle = 1\nconst other = 2\n", "app");
  writeFileSync(join(repo, "draft.ts"), "// needle ici\n");

  const result = await explorer.search(projectId, repo, "needle");

  expect(result.matches).toEqual(expect.arrayContaining([
    { path: "src/app.ts", line: 1, text: "const Needle = 1" },
    { path: "draft.ts", line: 1, text: "// needle ici" },
  ]));
  expect(result.truncated).toBe(false);
  expect((await explorer.search(projectId, repo, "introuvable")).matches).toEqual([]);
});

test("refuse un état du code hors du projet et un chemin qui sort du dépôt", async () => {
  const outside = join(root, "outside");
  initRepo(outside);

  await expect(explorer.files(projectId, outside)).rejects.toThrow("état du code inconnu");
  await expect(explorer.file(projectId, repo, "../outside/x")).rejects.toThrow("chemin de fichier invalide");
  await expect(explorer.commit(projectId, repo, "HEAD; rm")).rejects.toThrow("référence Git invalide");
});
