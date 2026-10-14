import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeSource } from "../src/code-explorer";
import { planEditorWorkspace } from "../src/editor-workspace";
import type { Conversation } from "../src/stores/conversations";
import type { Project } from "../src/stores/projects";

const root = mkdtempSync(join(tmpdir(), "pupitre-editor-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

function repository(path: string) {
  mkdirSync(path, { recursive: true });
  git(path, "init", "-q", "-b", "develop");
  git(path, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
}

const mono = join(root, "mono");
repository(mono);
writeFileSync(join(mono, "mono.code-workspace"), JSON.stringify({
  folders: [{ path: "." }, { path: "apps/reactor" }, { path: "apps/hapigator" }],
  settings: { "editor.tabSize": 2 },
}));
const reactor = join(mono, "apps/reactor");
const hapigator = join(mono, "apps/hapigator");
repository(reactor);
repository(hapigator);
const monoWorktree = join(root, "worktrees/feature-TECH-123");
git(mono, "worktree", "add", "-q", "-b", "feature/TECH-123", monoWorktree);
git(reactor, "worktree", "add", "-q", "-b", "feature/TECH-123", join(mono, "apps/reactor-tech123"));
git(hapigator, "worktree", "add", "-q", "-b", "feature/autre-tech123", join(mono, "apps/hapigator-autre-tech123"));
git(hapigator, "worktree", "add", "-q", "-b", "feature/TECH-123-before", join(mono, "apps/hapigator-tech123-before"));
git(hapigator, "worktree", "add", "-q", "-b", "feature/TECH-123-bis", join(mono, "apps/hapigator-tech123"));

function source(repositoryPath: string, path: string, branch: string): CodeSource {
  return {
    path, repositoryPath, repositoryLabel: "", branch, head: null, detached: false,
    main: path === repositoryPath, conversations: [], ref: null, updatedAt: null,
  };
}

const sources = [
  source(mono, mono, "develop"),
  source(mono, monoWorktree, "feature/TECH-123"),
  source(reactor, reactor, "develop"),
  source(reactor, join(mono, "apps/reactor-tech123"), "feature/TECH-123"),
  source(hapigator, hapigator, "develop"),
  source(hapigator, join(mono, "apps/hapigator-autre-tech123"), "feature/autre-tech123"),
  source(hapigator, join(mono, "apps/hapigator-tech123-before"), "feature/TECH-123-before"),
  source(hapigator, join(mono, "apps/hapigator-tech123"), "feature/TECH-123-bis"),
];
const project = { id: "p", name: "mono", path: mono } as Project;

test("assemble le monorepo et les worktrees de la branche de la conversation", () => {
  const conversation = { id: "c", worktree_path: monoWorktree, worktree_paths: [monoWorktree] } as Conversation;
  const plan = planEditorWorkspace(project, conversation, sources);

  expect(plan.folders.map((folder) => [folder.name, folder.path])).toEqual([
    ["mono", monoWorktree],
    ["reactor", join(mono, "apps/reactor-tech123")],
    ["hapigator", join(mono, "apps/hapigator-tech123")],
  ]);
  expect(plan.workspace?.fileName).toBe("mono-feature-TECH-123.code-workspace");
  expect(plan.workspace?.content.settings).toEqual({ "editor.tabSize": 2 });
});

test("sans worktree, un projet sans fichier workspace ouvre son dossier", () => {
  const solo = join(root, "solo");
  repository(solo);
  const plan = planEditorWorkspace(
    { id: "s", name: "solo", path: solo } as Project,
    { id: "c", worktree_path: null } as Conversation,
    [source(solo, solo, "develop")],
  );

  expect(plan.workspace).toBeNull();
  expect(plan.folders.map((folder) => folder.path)).toEqual([solo]);
});
