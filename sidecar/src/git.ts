import type { Database } from "bun:sqlite";
import type { ProjectStore } from "./stores/projects";

const MAX_GIT_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_COMMITS = 200;

export class GitProjectError extends Error {}

export interface GitGuardianSummary {
  reviewIds: string[];
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
  guardian: GitGuardianSummary | null;
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

export class GitProjectService {
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
    if (!head) throw new GitProjectError("le projet n'est pas un dépôt Git avec commits");
    const currentBranch = this.optionalGit(cwd, ["symbolic-ref", "--short", "-q", "HEAD"])
      ?.trim() || null;
    const links = this.commitLinks(projectId);
    const guardian = this.guardianByCommit(projectId, cwd);
    const commits = this.parseCommits(this.runGit(cwd, [
      "log",
      "--all",
      `--max-count=${MAX_COMMITS}`,
      "--date=iso-strict",
      "--pretty=format:%H%x1f%P%x1f%D%x1f%an%x1f%aI%x1f%s%x1e",
    ])).map((commit) => ({
      ...commit,
      conversations: links.get(commit.sha) ?? [],
      guardian: guardian.get(commit.sha) ?? null,
    }));
    return {
      head,
      currentBranch,
      commits,
      branches: this.branches(cwd),
      worktrees: this.worktrees(cwd),
    };
  }

  diff(projectId: string, baseRef: string, headRef: string): GitDiff {
    const cwd = this.projectPath(projectId);
    const base = this.resolve(cwd, baseRef);
    const head = this.resolve(cwd, headRef);
    const diff = this.runGit(cwd, [
      "diff",
      "--no-ext-diff",
      "--unified=3",
      "--find-renames",
      `${base}...${head}`,
      "--",
    ]);
    return { base, head, diff };
  }

  commitsBetween(projectId: string, before: string, after: string): string[] {
    if (before === after) return [];
    const cwd = this.projectPath(projectId);
    const base = this.resolve(cwd, before);
    const head = this.resolve(cwd, after);
    const isForward = Bun.spawnSync(
      ["git", "merge-base", "--is-ancestor", base, head],
      { cwd, stdout: "pipe", stderr: "pipe" },
    ).exitCode === 0;
    if (!isForward) return [head];
    return this.runGit(cwd, [
      "rev-list",
      "--reverse",
      `--max-count=${MAX_COMMITS}`,
      head,
      `^${base}`,
    ]).split("\n").map((sha) => sha.trim()).filter(Boolean);
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

  private optionalGit(cwd: string, args: string[]): string | null {
    try {
      return this.runGit(cwd, args);
    } catch {
      return null;
    }
  }

  private parseCommits(output: string): Omit<GitCommit, "conversations" | "guardian">[] {
    return output.split("\x1e").map((record) => record.trim()).filter(Boolean).map((record) => {
      const [sha = "", rawParents = "", rawRefs = "", author = "", authoredAt = "", subject = ""] =
        record.split("\x1f");
      return {
        sha,
        parents: rawParents.split(" ").filter(Boolean),
        refs: rawRefs.split(",").map((ref) => ref.trim()).filter(Boolean),
        author,
        authoredAt,
        subject,
      };
    });
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

  private guardianByCommit(projectId: string, cwd: string): Map<string, GitGuardianSummary> {
    const rows = this.db.query(`
      SELECT r.id AS review_id, r.git_ref_head, f.severity, COUNT(*) AS count
      FROM reviews r
      JOIN review_flags f ON f.review_id = r.id
      WHERE r.project_id = ? AND r.status = 'done'
      GROUP BY r.id, r.git_ref_head, f.severity
      ORDER BY r.created_at
    `).all(projectId) as Array<{
      review_id: string;
      git_ref_head: string;
      severity: "red" | "orange" | "grey";
      count: number | bigint;
    }>;
    const summaries = new Map<string, GitGuardianSummary>();
    for (const row of rows) {
      const sha = this.tryResolve(cwd, row.git_ref_head);
      if (!sha) continue;
      const summary = summaries.get(sha) ?? {
        reviewIds: [], red: 0, orange: 0, grey: 0,
      };
      if (!summary.reviewIds.includes(row.review_id)) summary.reviewIds.push(row.review_id);
      summary[row.severity] += Number(row.count);
      summaries.set(sha, summary);
    }
    return summaries;
  }
}
