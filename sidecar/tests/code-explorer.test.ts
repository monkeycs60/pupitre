import { beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentFromTrailers, CodeExplorerService } from "../src/code-explorer";
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

test("repère l'agent co-auteur par trailer et sort les dépôts imbriqués de la liste des fichiers", async () => {
  writeFileSync(join(repo, "agent.ts"), "a\nb\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "ajoute agent\n\nCo-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>");
  const agentSha = git(repo, "rev-parse", "HEAD");
  const web = join(repo, "apps", "web");
  initRepo(web);
  commit(web, "index.ts", "x\n", "web");
  const vendor = join(root, "vendor-origin");
  initRepo(vendor);
  commit(vendor, "lib.ts", "y\n", "lib");
  git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", vendor, "vendor");

  const files = await explorer.files(projectId, repo);
  expect(files.submodules).toEqual(["apps/web", "vendor"]);
  expect(files.paths).toContain(".gitmodules");
  expect(files.paths.some((path) => path === "vendor" || path.startsWith("apps/web"))).toBe(false);
  expect(files.dirty.some((item) => item.path.startsWith("vendor") || item.path.startsWith("apps/web"))).toBe(false);

  const expected = { provider: "claude" as const, name: "Claude Opus 5 (1M context)" };
  const graph = await explorer.graph(projectId, repo);
  expect(graph.commits.find((item) => item.sha === agentSha)?.agent).toEqual(expected);
  expect(graph.commits.find((item) => item.subject === "socle")?.agent).toBeNull();
  expect((await explorer.commit(projectId, repo, agentSha)).agent).toEqual(expected);
  expect((await explorer.blame(projectId, repo, "agent.ts")).groups[0]?.agent).toEqual(expected);
  expect(agentFromTrailers("Jane Doe <jane@example.test>\x1fCodex <codex@openai.com>")).toEqual({ provider: "codex", name: "Codex" });
  expect(agentFromTrailers("Jane Doe <jane@example.test>")).toBeNull();
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
  expect(graph.focusCommits.map((item) => item.subject)).toEqual(["feature"]);
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

test("sans commit, le diff d'un fichier montre ses modifications non commitées, fichier non suivi compris", async () => {
  commit(repo, "src/app.ts", "const a = 1\n", "app");
  writeFileSync(join(repo, "src/app.ts"), "const a = 2\n");
  writeFileSync(join(repo, "draft.ts"), "brouillon\n");

  expect((await explorer.diff(projectId, repo, "", "src/app.ts")).diff).toContain("+const a = 2");
  expect((await explorer.diff(projectId, repo, "", "draft.ts")).diff).toContain("+brouillon");
  expect((await explorer.diff(projectId, repo, "", "README.md")).diff).toBe("");
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

test("expose les branches à clé de ticket sans worktree, en lecture seule, même fusionnées", async () => {
  git(repo, "checkout", "-q", "-b", "feature/TECH-1234");
  const own = commit(repo, "ticket.ts", "export const ticket = 1\n", "feat(TECH-1234): ticket");
  git(repo, "checkout", "-q", "main");
  commit(repo, "main.ts", "1\n", "main avance");
  git(repo, "merge", "-q", "--no-ff", "-m", "Merge branch 'feature/TECH-1234'", "feature/TECH-1234");
  writeFileSync(join(repo, "ticket.ts"), "modifié dans le worktree\n");

  const branch = (await explorer.sources(projectId)).find((source) => source.ref === "feature/TECH-1234");
  expect(branch).toMatchObject({ path: `${repo}#feature/TECH-1234`, branch: "feature/TECH-1234", main: false, repositoryPath: repo });

  const files = await explorer.files(projectId, branch!.path);
  expect(files.paths).toContain("ticket.ts");
  expect(files.dirty).toEqual([]);
  expect((await explorer.file(projectId, branch!.path, "ticket.ts")).content).toBe("export const ticket = 1\n");
  const graph = await explorer.graph(projectId, branch!.path);
  expect(graph.head).toBe(own);
  expect(graph.focusCommits.map((item) => item.sha)).toEqual([own]);
  expect((await explorer.search(projectId, branch!.path, "ticket = 1")).matches).toEqual([{ path: "ticket.ts", line: 1, text: "export const ticket = 1" }]);
  expect((await explorer.blame(projectId, branch!.path, "ticket.ts")).groups[0]?.sha).toBe(own);
  expect((await explorer.diff(projectId, branch!.path, "", "ticket.ts")).diff).toBe("");
});

test("rattrape la provenance des commits faits pendant un tour, dépôt imbriqué compris, sans ceux des collègues", async () => {
  const api = join(repo, "apps", "api");
  initRepo(api);
  const started = new Date(Date.now() - 60_000).toISOString();
  const completed = new Date(Date.now() + 60_000).toISOString();
  db.query("INSERT INTO events (conversation_id, payload, created_at) VALUES (?, ?, ?)")
    .run(conversationId, JSON.stringify({ type: "turn-timing", phase: "completed", startedAt: started, completedAt: completed }), completed);
  const mine = commit(api, "index.ts", "x\n", "api");
  git(api, "-c", "user.email=collegue@example.test", "commit", "--allow-empty", "-qm", "collègue");
  const colleague = git(api, "rev-parse", "HEAD");

  const graph = await explorer.graph(projectId, api);

  expect(graph.commits.find((item) => item.sha === mine)?.conversations).toEqual([{ id: conversationId, title: expect.any(String), provider: "claude" }]);
  expect(graph.commits.find((item) => item.sha === colleague)?.conversations).toEqual([]);
});

test("liste les fichiers changés par la branche et leur diff cumulé, branche fusionnée comprise", async () => {
  git(repo, "checkout", "-q", "-b", "feature/TECH-777");
  commit(repo, "a.ts", "a\n", "a");
  commit(repo, "a.ts", "a\nb\n", "a encore");
  commit(repo, "c.ts", "c\n", "c");
  git(repo, "checkout", "-q", "main");
  commit(repo, "main.ts", "1\n", "main avance");
  const worktree = join(root, "tech-777");
  git(repo, "worktree", "add", "-q", worktree, "feature/TECH-777");

  const open = await explorer.changes(projectId, worktree);
  expect(open.base).toBe("main");
  expect(open.files.map((file) => [file.path, file.status, file.added])).toEqual([["a.ts", "A", 2], ["c.ts", "A", 1]]);
  expect((await explorer.diff(projectId, worktree, "", "a.ts", "branch")).diff).toContain("+b");

  git(repo, "merge", "-q", "--no-ff", "-m", "Merge feature", "feature/TECH-777");
  const merged = await explorer.changes(projectId, worktree);
  expect(merged.from).toMatch(/\^1$/);
  expect(merged.files.map((file) => file.path)).toEqual(["a.ts", "c.ts"]);
});

test("regroupe par dépôt les commits reliés à une conversation", async () => {
  const api = join(repo, "apps", "api");
  initRepo(api);
  const rootCommit = commit(repo, "root.ts", "1\n", "racine");
  const apiCommit = commit(api, "api.ts", "1\n", "api");
  const insert = db.query("INSERT INTO commit_links (commit_sha, project_id, conversation_id, created_at) VALUES (?, ?, ?, ?)");
  insert.run(rootCommit, projectId, conversationId, new Date().toISOString());
  insert.run(apiCommit, projectId, conversationId, new Date().toISOString());

  const result = await explorer.conversationCommits(projectId, conversationId);

  expect(result.total).toBe(2);
  expect(result.repositories.map((item) => [item.repositoryLabel, item.commits.map((entry) => entry.subject)])).toEqual([
    ["mono", ["racine"]],
    ["apps/api", ["api"]],
  ]);
  expect(result.ticket).toBeNull();
});

test("expose le chantier du ticket à une conversation du même ticket qui n'a rien commité", async () => {
  const conversations = new ConversationStore(db);
  const worker = conversations.create({
    projectId, provider: "claude", model: "claude-opus-5", firstMessage: "migre", createdOnBranch: "feature/TECH-24128",
  }).id;
  const reader = conversations.create({
    projectId, provider: "claude", model: "claude-opus-5", firstMessage: "outil", worktreePath: join(root, "feature-TECH-24128"),
  }).id;
  const other = conversations.create({
    projectId, provider: "claude", model: "claude-opus-5", firstMessage: "autre", createdOnBranch: "feature/TECH-9999",
  }).id;
  const insert = db.query("INSERT INTO commit_links (commit_sha, project_id, conversation_id, created_at) VALUES (?, ?, ?, ?)");
  git(repo, "checkout", "-q", "-b", "feature/TECH-24128");
  insert.run(commit(repo, "a.ts", "1\n", "TECH-24128 migration"), projectId, worker, new Date().toISOString());
  insert.run(commit(repo, "b.ts", "1\n", "TECH-24128 reprise"), projectId, worker, new Date().toISOString());
  commit(repo, "d.ts", "1\n", "TECH-24128 fait hors Pupitre");
  git(repo, "checkout", "-q", "main");
  insert.run(commit(repo, "c.ts", "1\n", "TECH-9999 ailleurs"), projectId, other, new Date().toISOString());

  const result = await explorer.conversationCommits(projectId, reader);

  expect(result.total).toBe(0);
  expect(result.repositories).toEqual([]);
  expect(result.ticket?.key).toBe("TECH-24128");
  expect(result.ticket?.branchCommits).toBe(3);
  expect(result.ticket?.total).toBe(2);
  expect(result.ticket?.repositories.map((item) => item.commits.map((entry) => entry.subject).sort())).toEqual([["TECH-24128 migration", "TECH-24128 reprise"]]);
  expect(result.ticket?.conversations.map((item) => [item.id, item.commits])).toEqual([[worker, 2]]);

  const own = await explorer.conversationCommits(projectId, worker);
  expect(own.total).toBe(2);
  expect(own.ticket?.total).toBe(2);
});

test("refuse un état du code hors du projet et un chemin qui sort du dépôt", async () => {
  const outside = join(root, "outside");
  initRepo(outside);

  await expect(explorer.files(projectId, outside)).rejects.toThrow("état du code inconnu");
  await expect(explorer.file(projectId, repo, "../outside/x")).rejects.toThrow("chemin de fichier invalide");
  await expect(explorer.commit(projectId, repo, "HEAD; rm")).rejects.toThrow("référence Git invalide");
});

test("mesure l'écart avec la base, prévoit les conflits et ne fusionne que sans conflit", async () => {
  const origin = join(root, "origin.git");
  git(root, "clone", "-q", "--bare", repo, origin);
  git(repo, "remote", "add", "origin", origin);
  git(repo, "fetch", "-q", "origin");
  git(repo, "branch", "develop", "main");
  git(repo, "push", "-q", "origin", "develop");
  const worktree = join(root, "feature");
  git(repo, "worktree", "add", "-q", "-b", "feature", worktree, "origin/develop");
  commit(worktree, "src/shared.ts", "feature\n", "feature");
  commit(worktree, "src/own.ts", "own\n", "own");

  const upstream = join(root, "upstream");
  git(root, "clone", "-q", "-b", "develop", origin, upstream);
  git(upstream, "config", "user.email", "git@example.test");
  git(upstream, "config", "user.name", "Git Fixture");
  commit(upstream, "src/other.ts", "other\n", "autre travail");
  git(upstream, "push", "-q", "origin", "develop");

  const stale = await explorer.sync(projectId, worktree);
  expect(stale).toMatchObject({ base: "origin/develop", branch: "feature", behind: 0, ahead: 2, mergeable: true });

  const fetched = await explorer.sync(projectId, worktree, { fetch: true });
  expect(fetched).toMatchObject({ behind: 1, ahead: 2, conflicts: [], fetchError: null });

  const merged = await explorer.merge(projectId, worktree);
  expect(merged).toMatchObject({ behind: 0, ahead: 3 });

  commit(upstream, "src/shared.ts", "develop\n", "même fichier");
  git(upstream, "push", "-q", "origin", "develop");
  const conflicted = await explorer.sync(projectId, worktree, { fetch: true });
  expect(conflicted.conflicts).toEqual(["src/shared.ts"]);
  const before = git(worktree, "rev-parse", "HEAD");
  await expect(explorer.merge(projectId, worktree)).rejects.toThrow("conflit");
  expect(git(worktree, "rev-parse", "HEAD")).toBe(before);
  expect(git(worktree, "status", "--porcelain")).toBe("");
});
