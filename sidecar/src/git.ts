import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { dataDir } from "./db";
import type { ProjectStore } from "./stores/projects";

const MAX_GIT_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_COMMITS = 200;

/**
 * Un nom de branche sert de nom de dossier : tout ce qui pourrait sortir du
 * dossier géré par Pupitre est refusé. Git accepte les `/` dans les branches,
 * on les aplatit plutôt que de creuser une arborescence.
 */
const SAFE_BRANCH = /^[A-Za-z0-9._/-]+$/;

export class GitProjectError extends Error {}

export interface GitGuardianReview {
  reviewId: string;
  red: number;
  orange: number;
  grey: number;
}

export interface GitCommit {
  sha: string;
  parents: string[];
  refs: string[];
  author: string;
  authoredAt: string;
  subject: string;
  conversations: Array<{ id: string; title: string }>;
  guardian: GitGuardianReview[];
}

export interface GitBranch {
  name: string;
  fullName: string;
  sha: string;
  current: boolean;
  remote: boolean;
}

export interface GitWorktree {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
}

export type GitFileStatus = "M" | "A" | "D" | "?";

export interface GitDirtyFile {
  path: string;
  status: GitFileStatus;
  added: number;
  removed: number;
  staged: boolean;
}

export interface GitIncomingCommit {
  sha: string;
  subject: string;
  author: string;
  authoredAt: string;
}

export interface GitConflictPath {
  path: string;
}

export interface GitSnapshot {
  head: string | null;
  headParents: string[];
  currentBranch: string | null;
  commits: GitCommit[];
  /** Commits propres à la branche courante depuis sa base principale. */
  branchCommitShas: string[];
  branchBase: string | null;
  branches: GitBranch[];
  worktrees: GitWorktree[];
  dirtyFiles: GitDirtyFile[];
  filePaths: string[];
  ahead: number;
  behind: number;
  incoming: GitIncomingCommit[];
  conflicts: GitConflictPath[];
}

export interface GitDiff {
  base: string;
  head: string;
  diff: string;
}

export interface GitFileContent {
  path: string;
  ref: string;
  content: string;
  sha: string | null;
  readonly: boolean;
}

export interface GitCommitResult {
  sha: string;
  message: string;
  paths: string[];
}

export interface GitTurnTracking {
  id: string;
  projectId: string;
  before: string | null;
  ambiguous: boolean;
}

export class GitProjectService {
  private activeTurns = new Map<string, Set<GitTurnTracking>>();

  private readonly worktreeRoot: string;

  constructor(
    private db: Database,
    private projects: ProjectStore,
    options: { worktreeRoot?: string } = {},
  ) {
    this.worktreeRoot = options.worktreeRoot ?? join(dataDir(), "worktrees");
  }

  /**
   * Crée — ou retrouve — le worktree d'une branche, dans un dossier possédé par
   * Pupitre. Hors du dépôt : un worktree imbriqué apparaîtrait comme des
   * fichiers non suivis dans le dépôt principal, et polluerait chaque diff.
   */
  createWorktree(projectId: string, input: { branch: string; startPoint?: string; repositoryPath?: string }): GitWorktree {
    const cwd = this.repositoryPath(projectId, input.repositoryPath);
    const branch = input.branch.trim();
    if (!branch || !SAFE_BRANCH.test(branch) || branch.includes("..")) {
      throw new GitProjectError(`nom de branche invalide : ${input.branch}`);
    }

    const existing = this.worktrees(cwd).find((item) => item.branch === branch);
    if (existing) return existing;

    const directory = join(this.worktreeRoot, projectId, branch.replaceAll("/", "-"));
    if (!resolve(directory).startsWith(resolve(this.worktreeRoot))) {
      throw new GitProjectError(`nom de branche invalide : ${input.branch}`);
    }
    mkdirSync(join(this.worktreeRoot, projectId), { recursive: true });
    // Un dossier résiduel d'un worktree que git ne connaît plus ferait échouer
    // `worktree add` sans qu'aucune conversation ne s'y rattache.
    if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });

    const known = this.runGit(cwd, ["branch", "--list", branch]).trim() !== "";
    this.runGit(cwd, known
      ? ["worktree", "add", directory, branch]
      : ["worktree", "add", "-b", branch, directory, input.startPoint ?? "HEAD"]);

    const created = this.worktrees(cwd).find((item) => item.path === directory);
    if (!created) throw new GitProjectError("worktree créé mais introuvable");
    return created;
  }

  createDetachedWorktree(projectId: string, input: { name: string; startPoint: string; repositoryPath?: string }): GitWorktree {
    const cwd = this.repositoryPath(projectId, input.repositoryPath);
    const name = input.name.trim();
    if (!name || !SAFE_BRANCH.test(name) || name.includes("..")) {
      throw new GitProjectError(`nom de worktree invalide : ${input.name}`);
    }
    const repositoryDirectory = input.repositoryPath ? basename(cwd) : null;
    const directory = join(
      this.worktreeRoot,
      projectId,
      ...(repositoryDirectory ? [repositoryDirectory] : []),
      `detached-${name.replaceAll("/", "-")}`,
    );
    mkdirSync(join(this.worktreeRoot, projectId), { recursive: true });
    const existing = this.worktrees(cwd).find((item) => item.path === directory);
    if (existing) return existing;
    if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
    this.runGit(cwd, ["worktree", "add", "--detach", directory, input.startPoint]);
    const created = this.worktrees(cwd).find((item) => item.path === directory);
    if (!created) throw new GitProjectError("worktree détaché créé mais introuvable");
    return created;
  }

  preferredStartPoint(projectId: string, preferred: string, repositoryPath?: string): string {
    const cwd = this.repositoryPath(projectId, repositoryPath);
    if (this.tryResolve(cwd, preferred)) return preferred;
    const remoteHead = this.optionalGit(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])?.trim();
    return remoteHead && this.tryResolve(cwd, remoteHead) ? remoteHead : "HEAD";
  }

  /**
   * Retire un worktree et son dossier. Le dépôt principal et les worktrees
   * encore portés par une conversation sont protégés : les supprimer
   * emporterait le répertoire de travail d'agents en cours.
   */
  removeWorktree(projectId: string, path: string): void {
    const cwd = this.projectPath(projectId);
    if (resolve(path) === resolve(cwd)) {
      throw new GitProjectError("le dépôt principal ne peut pas être retiré");
    }
    const holders = this.db.query(
      "SELECT count(*) AS total FROM conversations WHERE worktree_path = ? AND deleted_at IS NULL",
    ).get(path) as { total: number };
    if (holders.total > 0) {
      throw new GitProjectError(
        `worktree encore utilisé par ${holders.total} conversation(s)`,
      );
    }
    this.runGit(cwd, ["worktree", "remove", "--force", path]);
    rmSync(path, { recursive: true, force: true });
  }

  /**
   * Les worktrees dont la branche est entièrement fusionnée dans HEAD : leur
   * suppression peut être proposée sans rien perdre.
   */
  mergedWorktrees(projectId: string): GitWorktree[] {
    const cwd = this.projectPath(projectId);
    const merged = new Set(
      this.runGit(cwd, ["branch", "--merged", "HEAD", "--format=%(refname:short)"])
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    );
    return this.worktrees(cwd).filter((item) =>
      resolve(item.path) !== resolve(cwd)
      && item.branch !== null
      && merged.has(item.branch)
    );
  }

  head(projectId: string): string | null {
    const cwd = this.projectPath(projectId);
    return this.tryResolve(cwd, "HEAD");
  }

  snapshot(projectId: string, requestedCwd?: string | null): GitSnapshot {
    const cwd = this.workspacePath(projectId, requestedCwd);
    if (!this.isGitRepository(cwd)) {
      return {
        head: null,
        headParents: [],
        currentBranch: null,
        commits: [],
        branchCommitShas: [],
        branchBase: null,
        branches: [],
        worktrees: [],
        dirtyFiles: [],
        filePaths: [],
        ahead: 0,
        behind: 0,
        incoming: [],
        conflicts: [],
      };
    }
    const head = this.tryResolve(cwd, "HEAD");
    const currentBranch = this.optionalGit(cwd, ["symbolic-ref", "--short", "-q", "HEAD"])
      ?.trim() || null;
    const links = this.commitLinks(projectId);
    const guardian = this.guardianByCommit(projectId, cwd);
    const branches = this.branches(cwd);
    let commits = head ? this.parseCommits(this.runGit(cwd, [
      "log", "-z", "--all", "--topo-order",
      `--max-count=${MAX_COMMITS}`,
      "--date=iso-strict",
      "--format=%H%x00%P%x00%D%x00%an%x00%aI%x00%s",
    ])) : [];
    if (head && !commits.some((commit) => commit.sha === head)) {
      const headCommit = this.parseCommits(this.runGit(cwd, [
        "log", "-z", "-1", "--date=iso-strict",
        "--format=%H%x00%P%x00%D%x00%an%x00%aI%x00%s", head,
      ]))[0];
      if (headCommit) commits = [headCommit, ...commits.slice(0, MAX_COMMITS - 1)];
    }
    const headParents = commits.find((commit) => commit.sha === head)?.parents ?? [];
    const hydrated = commits.map((commit) => ({
      ...commit,
      conversations: links.get(commit.sha) ?? [],
      guardian: guardian.get(commit.sha) ?? [],
    }));
    const baseBranch = branches.find((branch) => branch.name === "origin/master")
      ?? branches.find((branch) => branch.name === "origin/main")
      ?? branches.find((branch) => branch.name === "master" && branch.name !== currentBranch)
      ?? branches.find((branch) => branch.name === "main" && branch.name !== currentBranch)
      ?? null;
    const branchCommitShas = head && baseBranch
      ? this.runGit(cwd, ["rev-list", "--topo-order", `--max-count=${MAX_COMMITS}`, `${baseBranch.sha}..${head}`])
        .split("\n").filter(Boolean)
      : hydrated.map((commit) => commit.sha);
    const dirtyFiles = this.dirtyFiles(cwd);
    const filePaths = this.filePaths(cwd);
    const divergence = baseBranch && head
      ? this.revListCounts(cwd, baseBranch.name, head)
      : { ahead: 0, behind: 0 };
    const incoming = baseBranch && head ? this.incomingCommits(cwd, baseBranch.name, head) : [];
    const conflicts = baseBranch && head ? this.conflicts(cwd, baseBranch.name, head) : [];
    return {
      head,
      headParents,
      currentBranch,
      commits: hydrated,
      branchCommitShas,
      branchBase: baseBranch?.name ?? null,
      branches,
      worktrees: this.worktrees(cwd),
      dirtyFiles,
      filePaths,
      ...divergence,
      incoming,
      conflicts,
    };
  }

  async workingTreeDiff(projectId: string, requestedCwd?: string | null): Promise<GitDiff> {
    const cwd = this.workspacePath(projectId, requestedCwd);
    const head = this.tryResolve(cwd, "HEAD");
    return {
      base: head ?? "EMPTY_TREE",
      head: head ?? "WORKTREE",
      diff: await this.worktreeDiff(cwd, head),
    };
  }

  file(
    projectId: string,
    path: string,
    ref: string,
    requestedCwd?: string | null,
  ): GitFileContent {
    const cwd = this.workspacePath(projectId, requestedCwd);
    const safePath = this.safePath(cwd, path);
    const normalizedRef = ref.trim() || "worktree";
    if (normalizedRef === "worktree" || normalizedRef === "WORKTREE") {
      const absolute = join(cwd, safePath);
      if (!existsSync(absolute) || !statSync(absolute).isFile()) {
        throw new GitProjectError(`fichier introuvable : ${safePath}`);
      }
      const content = readFileSync(absolute, "utf8");
      if (Buffer.byteLength(content) > MAX_GIT_OUTPUT_BYTES) {
        throw new GitProjectError("fichier trop volumineux");
      }
      return { path: safePath, ref: "worktree", content, sha: null, readonly: false };
    }
    const sha = this.resolve(cwd, normalizedRef);
    const content = this.runGit(cwd, ["show", `${sha}:${safePath}`]);
    return { path: safePath, ref: normalizedRef, content, sha, readonly: true };
  }

  commit(
    projectId: string,
    requestedCwd: string | null | undefined,
    paths: string[],
    message: string,
    conversationId?: string | null,
  ): GitCommitResult {
    const cwd = this.workspacePath(projectId, requestedCwd);
    const safePaths = [...new Set(paths.map((path) => this.safePath(cwd, path)))];
    if (safePaths.length === 0) throw new GitProjectError("aucun fichier sélectionné");
    const trimmedMessage = message.trim();
    if (!trimmedMessage) throw new GitProjectError("message de commit vide");
    this.runGit(cwd, ["add", "--", ...safePaths]);
    this.runGit(cwd, ["commit", "--only", "-m", trimmedMessage, "--", ...safePaths]);
    const sha = this.resolve(cwd, "HEAD");
    if (conversationId) this.recordCommitLinks(projectId, conversationId, [sha]);
    return { sha, message: trimmedMessage, paths: safePaths };
  }

  async diff(
    projectId: string,
    baseRef: string,
    headRef: string,
    requestedCwd?: string | null,
  ): Promise<GitDiff> {
    const cwd = this.workspacePath(projectId, requestedCwd);
    const base = this.resolve(cwd, baseRef);
    const head = this.resolve(cwd, headRef);
    const diff = await this.runGitLimited(cwd, [
      "diff",
      "--no-ext-diff",
      "--unified=3",
      "--find-renames",
      `${base}...${head}`,
      "--",
    ]);
    return { base, head, diff };
  }

  commitsBetween(projectId: string, before: string | null, after: string): string[] {
    if (before === after) return [];
    const cwd = this.projectPath(projectId);
    const head = this.resolve(cwd, after);
    if (before === null) {
      return this.runGit(cwd, [
        "rev-list", "--reverse", "--topo-order", head,
      ]).split("\n").map((sha) => sha.trim()).filter(Boolean);
    }
    const base = this.resolve(cwd, before);
    const isForward = Bun.spawnSync(
      ["git", "merge-base", "--is-ancestor", base, head],
      { cwd, stdout: "pipe", stderr: "pipe" },
    ).exitCode === 0;
    if (!isForward) return [head];
    return this.runGit(cwd, [
      "rev-list",
      "--reverse",
      "--topo-order",
      head,
      `^${base}`,
    ]).split("\n").map((sha) => sha.trim()).filter(Boolean);
  }

  beginTurn(projectId: string): GitTurnTracking {
    const tracking: GitTurnTracking = {
      id: crypto.randomUUID(),
      projectId,
      before: this.head(projectId),
      ambiguous: false,
    };
    let active = this.activeTurns.get(projectId);
    if (!active) {
      active = new Set();
      this.activeTurns.set(projectId, active);
    }
    if (active.size > 0) {
      tracking.ambiguous = true;
      for (const concurrent of active) concurrent.ambiguous = true;
    }
    active.add(tracking);
    return tracking;
  }

  finishTurn(tracking: GitTurnTracking, conversationId: string): void {
    const active = this.activeTurns.get(tracking.projectId);
    active?.delete(tracking);
    if (active?.size === 0) this.activeTurns.delete(tracking.projectId);
    if (tracking.ambiguous) return;
    const after = this.head(tracking.projectId);
    if (!after || after === tracking.before) return;
    this.recordCommitLinks(
      tracking.projectId,
      conversationId,
      this.commitsBetween(tracking.projectId, tracking.before, after),
    );
  }

  recordCommitLinks(projectId: string, conversationId: string, shas: string[]): void {
    if (shas.length === 0) return;
    const record = this.db.transaction(() => {
      const insert = this.db.query(`
        INSERT OR IGNORE INTO commit_links
          (commit_sha, project_id, conversation_id, created_at)
        VALUES (?, ?, ?, ?)
      `);
      const now = new Date().toISOString();
      for (const sha of shas) insert.run(sha, projectId, conversationId, now);
    });
    record();
  }

  /** Un COUNT plutôt que des stats détaillées : l'ancienne version lançait
   *  deux `git` en spawnSync par commit lié, gelant l'event loop ~350 ms sur
   *  le `GET /api/time` déclenché à chaque clic projet/conversation. */
  linkedCommitCount(projectId?: string): number {
    const row = this.db.query(`
      SELECT COUNT(*) AS count FROM commit_links
      ${projectId ? "WHERE project_id = ?" : ""}
    `).get(...(projectId ? [projectId] : [])) as { count: number };
    return row.count;
  }

  private projectPath(projectId: string): string {
    const project = this.projects.get(projectId);
    if (!project) throw new GitProjectError("projet inconnu");
    return project.path;
  }

  private repositoryPath(projectId: string, requestedPath?: string): string {
    const projectPath = resolve(this.projectPath(projectId));
    if (!requestedPath) return projectPath;
    const candidate = resolve(requestedPath);
    const rel = relative(projectPath, candidate);
    if (rel.startsWith("..") || resolve(this.optionalGit(candidate, ["rev-parse", "--show-toplevel"])?.trim() ?? "") !== candidate) {
      throw new GitProjectError("dépôt applicatif invalide");
    }
    return candidate;
  }

  /**
   * Résout le dépôt réellement montré par l'atelier Git. Un chemin fourni par
   * le client n'est accepté que s'il correspond à un worktree enregistré par
   * Git pour ce projet : impossible de transformer ce paramètre en accès à un
   * dossier arbitraire.
   */
  private workspacePath(projectId: string, requestedCwd?: string | null): string {
    const projectPath = this.projectPath(projectId);
    if (!requestedCwd) return projectPath;
    const wanted = resolve(requestedCwd);
    const known = this.worktrees(projectPath).some((item) => resolve(item.path) === wanted);
    if (!known) throw new GitProjectError("worktree inconnu pour ce projet");
    return wanted;
  }

  private resolve(cwd: string, ref: string): string {
    const resolved = this.tryResolve(cwd, ref);
    if (!resolved) throw new GitProjectError(`référence Git invalide : ${ref}`);
    return resolved;
  }

  private tryResolve(cwd: string, ref: string): string | null {
    if (ref.trim() === "" || ref.includes("\0")) return null;
    const result = Bun.spawnSync([
      "git",
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `${ref}^{commit}`,
    ], { cwd, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) return null;
    return result.stdout.toString().trim() || null;
  }

  private runGit(cwd: string, args: string[]): string {
    const result = Bun.spawnSync(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      const detail = result.stderr.toString().trim();
      throw new GitProjectError(detail || "commande Git impossible");
    }
    if (result.stdout.byteLength > MAX_GIT_OUTPUT_BYTES) {
      throw new GitProjectError("sortie Git trop volumineuse");
    }
    return result.stdout.toString();
  }

  private async runGitLimited(cwd: string, args: string[], acceptedExitCodes = [0]): Promise<string> {
    const child = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    const stderrPromise = new Response(child.stderr).text();
    const reader = child.stdout.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let exceeded = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_GIT_OUTPUT_BYTES) {
          exceeded = true;
          child.kill();
          break;
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const [exitCode, stderr] = await Promise.all([child.exited, stderrPromise]);
    if (exceeded) throw new GitProjectError("sortie Git trop volumineuse");
    if (!acceptedExitCodes.includes(exitCode)) {
      throw new GitProjectError(stderr.trim() || "commande Git impossible");
    }
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(output);
  }

  private dirtyFiles(cwd: string): GitDirtyFile[] {
    const status = this.runGit(cwd, ["status", "--porcelain=v2", "-z", "--untracked-files=normal"]);
    const additions = this.numstat(cwd, false);
    const stagedAdditions = this.numstat(cwd, true);
    return status.split("\0").filter(Boolean).flatMap((entry) => {
      const fields = entry.split(" ");
      const kind = entry[0];
      const xy = fields[1] ?? "..";
      const path = kind === "?" ? entry.slice(2) : kind === "2" ? fields.slice(9).join(" ") : fields.slice(8).join(" ");
      if (!path) return [];
      const statusCode: GitFileStatus = kind === "?"
        ? "?"
        : xy.includes("D") ? "D"
          : xy.includes("A") ? "A"
            : "M";
      const current = additions.get(path) ?? { added: 0, removed: 0 };
      const staged = stagedAdditions.get(path) ?? { added: 0, removed: 0 };
      return [{
        path,
        status: statusCode,
        added: current.added + staged.added,
        removed: current.removed + staged.removed,
        staged: kind !== "?" && xy[0] !== ".",
      }];
    });
  }

  private numstat(cwd: string, cached: boolean): Map<string, { added: number; removed: number }> {
    const output = this.runGit(cwd, ["diff", ...(cached ? ["--cached"] : []), "--numstat", "--"]);
    const result = new Map<string, { added: number; removed: number }>();
    for (const line of output.split("\n")) {
      const [rawAdded, rawRemoved, ...rawPath] = line.split("\t");
      const path = rawPath.join("\t");
      if (!path) continue;
      result.set(path, {
        added: /^\d+$/.test(rawAdded ?? "") ? Number(rawAdded) : 0,
        removed: /^\d+$/.test(rawRemoved ?? "") ? Number(rawRemoved) : 0,
      });
    }
    return result;
  }

  private filePaths(cwd: string): string[] {
    return this.runGit(cwd, ["ls-files", "-co", "--exclude-standard", "-z"])
      .split("\0").filter(Boolean).sort((left, right) => left.localeCompare(right));
  }

  private revListCounts(cwd: string, base: string, head: string): { ahead: number; behind: number } {
    const [behind = "0", ahead = "0"] = this.runGit(cwd, ["rev-list", "--left-right", "--count", `${base}...${head}`]).trim().split(/\s+/);
    return { ahead: Number(ahead) || 0, behind: Number(behind) || 0 };
  }

  private incomingCommits(cwd: string, base: string, head: string): GitIncomingCommit[] {
    const output = this.optionalGit(cwd, [
      "log", "--max-count=30", "--date=iso-strict", "--format=%H%x00%an%x00%aI%x00%s", `${head}..${base}`,
    ]) ?? "";
    const fields = output.split("\0").filter(Boolean);
    const commits: GitIncomingCommit[] = [];
    for (let index = 0; index + 3 < fields.length; index += 4) {
      const [sha = "", author = "", authoredAt = "", subject = ""] = fields.slice(index, index + 4);
      if (sha) commits.push({ sha, subject, author, authoredAt });
    }
    return commits;
  }

  private conflicts(cwd: string, base: string, head: string): GitConflictPath[] {
    const changedHere = new Set((this.optionalGit(cwd, ["diff", "--name-only", `${base}...${head}`]) ?? "").split("\n").filter(Boolean));
    const changedThere = (this.optionalGit(cwd, ["diff", "--name-only", `${head}..${base}`]) ?? "").split("\n").filter(Boolean);
    return changedThere.filter((path) => changedHere.has(path)).map((path) => ({ path }));
  }

  private async worktreeDiff(cwd: string, head: string | null): Promise<string> {
    const tracked = head
      ? await this.runGitLimited(cwd, ["diff", "--no-ext-diff", "--unified=3", "--find-renames", head, "--"])
      : "";
    const untracked = (await this.runGitLimited(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]))
      .split("\0").filter(Boolean);
    const parts = tracked ? [tracked] : [];
    for (const path of untracked) {
      const patch = await this.runGitLimited(cwd, [
        "diff", "--no-index", "--no-ext-diff", "--unified=3", "--", "/dev/null", path,
      ], [0, 1]);
      if (patch) parts.push(patch);
    }
    return parts.join("\n");
  }

  private safePath(cwd: string, path: string): string {
    const normalized = path.trim();
    const absolute = resolve(cwd, normalized);
    const rel = relative(resolve(cwd), absolute);
    if (!normalized || rel.startsWith("..") || rel.includes("\0") || resolve(cwd, rel) !== absolute) {
      throw new GitProjectError(`chemin de fichier invalide : ${path}`);
    }
    return rel;
  }

  private optionalGit(cwd: string, args: string[]): string | null {
    try {
      return this.runGit(cwd, args);
    } catch {
      return null;
    }
  }

  private isGitRepository(cwd: string): boolean {
    return this.optionalGit(cwd, ["rev-parse", "--is-inside-work-tree"])?.trim() === "true";
  }

  private parseCommits(output: string): Omit<GitCommit, "conversations" | "guardian">[] {
    const fields = output.split("\0");
    if (fields.at(-1) === "") fields.pop();
    if (fields.length % 6 !== 0) throw new GitProjectError("sortie git log invalide");
    const commits: Omit<GitCommit, "conversations" | "guardian">[] = [];
    for (let index = 0; index < fields.length; index += 6) {
      const [sha = "", rawParents = "", rawRefs = "", author = "", authoredAt = "", subject = ""] =
        fields.slice(index, index + 6);
      if (!/^[0-9a-f]{40,64}$/i.test(sha)
        || rawParents.split(" ").filter(Boolean).some((parent) => !/^[0-9a-f]{40,64}$/i.test(parent))
        || Number.isNaN(Date.parse(authoredAt))) {
        throw new GitProjectError("métadonnées de commit invalides");
      }
      commits.push({
        sha,
        parents: rawParents.split(" ").filter(Boolean),
        refs: rawRefs.split(",").map((ref) => ref.trim()).filter(Boolean),
        author,
        authoredAt,
        subject,
      });
    }
    return commits;
  }

  private branches(cwd: string): GitBranch[] {
    return this.runGit(cwd, [
      "for-each-ref",
      "--format=%(refname)%00%(refname:short)%00%(objectname)%00%(HEAD)",
      "refs/heads",
      "refs/remotes",
    ]).split("\n").filter(Boolean).map((line) => {
      const [fullName = "", name = "", sha = "", marker = ""] = line.split("\0");
      return {
        name,
        fullName,
        sha,
        current: marker.trim() === "*",
        remote: fullName.startsWith("refs/remotes/"),
      };
    });
  }

  private worktrees(cwd: string): GitWorktree[] {
    const output = this.runGit(cwd, ["worktree", "list", "--porcelain"]);
    return output.trim().split(/\n\n+/).filter(Boolean).map((block) => {
      const fields = new Map<string, string>();
      for (const line of block.split("\n")) {
        const separator = line.indexOf(" ");
        fields.set(separator === -1 ? line : line.slice(0, separator),
          separator === -1 ? "" : line.slice(separator + 1));
      }
      const rawBranch = fields.get("branch") ?? null;
      return {
        path: fields.get("worktree") ?? "",
        head: fields.get("HEAD") ?? null,
        branch: rawBranch?.replace(/^refs\/heads\//, "") ?? null,
        detached: fields.has("detached"),
        bare: fields.has("bare"),
      };
    });
  }

  private commitLinks(projectId: string): Map<string, Array<{ id: string; title: string }>> {
    const rows = this.db.query(`
      SELECT links.commit_sha, conversations.id, conversations.title
      FROM commit_links links
      JOIN conversations ON conversations.id = links.conversation_id
      WHERE links.project_id = ? ORDER BY links.created_at, conversations.id
    `).all(projectId) as Array<{ commit_sha: string; id: string; title: string }>;
    const links = new Map<string, Array<{ id: string; title: string }>>();
    for (const row of rows) {
      const conversations = links.get(row.commit_sha) ?? [];
      conversations.push({ id: row.id, title: row.title });
      links.set(row.commit_sha, conversations);
    }
    return links;
  }

  private guardianByCommit(projectId: string, cwd: string): Map<string, GitGuardianReview[]> {
    const rows = this.db.query(`
      SELECT r.id AS review_id, r.git_ref_head, f.severity, COUNT(f.id) AS count
      FROM reviews r
      LEFT JOIN review_flags f ON f.review_id = r.id
      WHERE r.project_id = ? AND r.status = 'done'
      GROUP BY r.id, r.git_ref_head, f.severity
      ORDER BY r.created_at
    `).all(projectId) as Array<{
      review_id: string;
      git_ref_head: string;
      severity: "red" | "orange" | "grey" | null;
      count: number | bigint;
    }>;
    const summaries = new Map<string, GitGuardianReview[]>();
    // `setDiff` fige un SHA complet : la quasi-totalité des lignes n'a plus
    // besoin d'un `rev-parse`. Les rares références héritées sont résolues une
    // seule fois — sans cela, la vue Git enchaîne jusqu'à quatre spawns
    // synchrones par review et fige le sidecar sur un projet chargé.
    const resolved = new Map<string, string | null>();
    const resolveHead = (ref: string): string | null => {
      if (/^[0-9a-f]{40}$/.test(ref)) return ref;
      if (!resolved.has(ref)) resolved.set(ref, this.tryResolve(cwd, ref));
      return resolved.get(ref) ?? null;
    };
    for (const row of rows) {
      // Les reviews WORKTREE récentes sont figées sur le SHA observé au scan.
      // Ne jamais résoudre un ancien marqueur WORKTREE sur le HEAD courant :
      // cela afficherait la review sur un commit qui n'a pas été analysé.
      if (row.git_ref_head === "WORKTREE") continue;
      const sha = resolveHead(row.git_ref_head);
      if (!sha) continue;
      const commitReviews = summaries.get(sha) ?? [];
      let summary = commitReviews.find((review) => review.reviewId === row.review_id);
      if (!summary) {
        summary = { reviewId: row.review_id, red: 0, orange: 0, grey: 0 };
        commitReviews.push(summary);
      }
      if (row.severity) summary[row.severity] += Number(row.count);
      summaries.set(sha, commitReviews);
    }
    return summaries;
  }
}
