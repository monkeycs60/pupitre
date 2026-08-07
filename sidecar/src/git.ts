import type { Database } from "bun:sqlite";
import type { ProjectStore } from "./stores/projects";

const MAX_GIT_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_COMMITS = 200;

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

export interface GitSnapshot {
  head: string | null;
  headParents: string[];
  currentBranch: string | null;
  commits: GitCommit[];
  branches: GitBranch[];
  worktrees: GitWorktree[];
}

export interface GitDiff {
  base: string;
  head: string;
  diff: string;
}

export interface GitLinkedCommit {
  sha: string;
  projectId: string;
  conversationId: string;
  linkedAt: string;
  authoredAt: string;
  additions: number;
  deletions: number;
  files: number;
  pushed: boolean;
}

export interface GitTurnTracking {
  id: string;
  projectId: string;
  before: string | null;
  ambiguous: boolean;
}

export class GitProjectService {
  private activeTurns = new Map<string, Set<GitTurnTracking>>();

  constructor(
    private db: Database,
    private projects: ProjectStore,
  ) {}

  head(projectId: string): string | null {
    const cwd = this.projectPath(projectId);
    return this.tryResolve(cwd, "HEAD");
  }

  snapshot(projectId: string): GitSnapshot {
    const cwd = this.projectPath(projectId);
    const head = this.tryResolve(cwd, "HEAD");
    const currentBranch = this.optionalGit(cwd, ["symbolic-ref", "--short", "-q", "HEAD"])
      ?.trim() || null;
    const links = this.commitLinks(projectId);
    const guardian = this.guardianByCommit(projectId, cwd);
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
    return {
      head,
      headParents,
      currentBranch,
      commits: hydrated,
      branches: this.branches(cwd),
      worktrees: this.worktrees(cwd),
    };
  }

  async diff(projectId: string, baseRef: string, headRef: string): Promise<GitDiff> {
    const cwd = this.projectPath(projectId);
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

  /** Statistiques des commits attribués à une conversation pour la progression. */
  linkedCommitStats(projectId?: string): GitLinkedCommit[] {
    const projects = projectId
      ? [this.projects.get(projectId)].filter((project): project is NonNullable<typeof project> => project !== null)
      : this.projects.list();
    const rows = this.db.query(`
      SELECT commit_sha, project_id, conversation_id, created_at
      FROM commit_links
      ${projectId ? "WHERE project_id = ?" : ""}
      ORDER BY created_at, commit_sha
    `).all(...(projectId ? [projectId] : [])) as Array<{
      commit_sha: string;
      project_id: string;
      conversation_id: string;
      created_at: string;
    }>;
    const paths = new Map(projects.map((project) => [project.id, project.path]));
    const stats: GitLinkedCommit[] = [];
    for (const row of rows) {
      const cwd = paths.get(row.project_id);
      if (!cwd) continue;
      try {
        const metadata = this.runGit(cwd, [
          "show", "--format=%aI", "--numstat", "--no-renames", row.commit_sha, "--",
        ]);
        const lines = metadata.split("\n");
        const authoredAt = lines.shift()?.trim() ?? "";
        let additions = 0;
        let deletions = 0;
        let files = 0;
        for (const line of lines) {
          const [rawAdditions, rawDeletions] = line.split("\t");
          if (rawAdditions === undefined || rawDeletions === undefined) continue;
          additions += /^\d+$/.test(rawAdditions) ? Number(rawAdditions) : 0;
          deletions += /^\d+$/.test(rawDeletions) ? Number(rawDeletions) : 0;
          files += 1;
        }
        stats.push({
          sha: row.commit_sha,
          projectId: row.project_id,
          conversationId: row.conversation_id,
          linkedAt: row.created_at,
          authoredAt,
          additions,
          deletions,
          files,
          pushed: this.isReachableFromRemote(cwd, row.commit_sha),
        });
      } catch {
        // Un commit supprimé du reflog ou un dépôt devenu indisponible ne doit
        // pas rendre la jauge de progression inutilisable.
      }
    }
    return stats;
  }

  private projectPath(projectId: string): string {
    const project = this.projects.get(projectId);
    if (!project) throw new GitProjectError("projet inconnu");
    return project.path;
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

  private async runGitLimited(cwd: string, args: string[]): Promise<string> {
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
    if (exitCode !== 0) {
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

  private optionalGit(cwd: string, args: string[]): string | null {
    try {
      return this.runGit(cwd, args);
    } catch {
      return null;
    }
  }

  private isReachableFromRemote(cwd: string, sha: string): boolean {
    const result = Bun.spawnSync(
      ["git", "branch", "--remotes", "--contains", sha],
      { cwd, stdout: "pipe", stderr: "pipe" },
    );
    return result.exitCode === 0 && result.stdout.toString().trim() !== "";
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
