import { join } from "node:path";
import type { CodeExplorerService, CodeSource } from "./code-explorer";
import type { Conversation } from "./stores/conversations";
import { conversationWorktrees } from "./workspace";
import { folderOfRepository, GENERATED_FILE, gitOutput, type EditorWorkspacePlan } from "./editor-workspace";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MAX_FILE_DIFF_LINES = 3_000;
const MAX_TOTAL_DIFF_BYTES = 4 * 1024 * 1024;
const MAX_UNTRACKED_FILES = 30;

export interface ChangedFileDiff {
  path: string;
  previousPath: string | null;
  status: "added" | "deleted" | "renamed" | "modified";
  added: number;
  removed: number;
  binary: boolean;
  generated: boolean;
  /** Diff unifié du fichier, en-têtes compris ; tronqué au-delà de MAX_FILE_DIFF_LINES lignes. */
  diff: string;
  truncated: boolean;
  /** Fichier sur le disque, absent quand il a été supprimé. */
  absolutePath: string | null;
  firstLine: number | null;
}

export interface RepositoryChanges {
  repositoryLabel: string;
  worktreePath: string;
  branch: string | null;
  kind: "commits" | "uncommitted";
  commits: number;
  /** Sujet du commit quand les commits de la conversation ne se suivent pas et s'affichent un par un. */
  title: string | null;
  files: ChangedFileDiff[];
}

export interface ConversationChanges {
  repositories: RepositoryChanges[];
  truncated: boolean;
}

/** Découpe un `git diff` multi-fichiers en un bloc par fichier. */
export function splitDiff(diff: string, worktreePath: string): ChangedFileDiff[] {
  const files: ChangedFileDiff[] = [];
  for (const block of diff.split(/^(?=diff --git )/m)) {
    if (!block.startsWith("diff --git ")) continue;
    const lines = block.replace(/\n$/, "").split("\n");
    const header = lines[0]!.match(/^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/);
    let previous = header?.[1] ?? "";
    let path = header?.[2] ?? previous;
    let status: ChangedFileDiff["status"] = "modified";
    let binary = false;
    let added = 0;
    let removed = 0;
    let firstLine: number | null = null;
    let inHunks = false;
    let newLine = 0;
    for (const line of lines) {
      if (!inHunks) {
        if (line.startsWith("new file mode")) status = "added";
        else if (line.startsWith("deleted file mode")) status = "deleted";
        else if (line.startsWith("rename from ")) { status = "renamed"; previous = line.slice(12); }
        else if (line.startsWith("rename to ")) path = line.slice(10);
        else if (line.startsWith("Binary files ")) binary = true;
      }
      if (line.startsWith("@@ ")) {
        inHunks = true;
        newLine = Number(line.match(/\+(\d+)/)?.[1] ?? 1);
      } else if (inHunks && line.startsWith("+")) {
        added += 1;
        firstLine ??= Math.max(1, newLine);
        newLine += 1;
      } else if (inHunks && line.startsWith("-")) {
        removed += 1;
        firstLine ??= Math.max(1, newLine);
      } else if (inHunks && !line.startsWith("\\")) {
        newLine += 1;
      }
    }
    const truncated = lines.length > MAX_FILE_DIFF_LINES;
    files.push({
      path,
      previousPath: status === "renamed" ? previous : null,
      status,
      added,
      removed,
      binary,
      generated: GENERATED_FILE.test(path),
      diff: (truncated ? lines.slice(0, MAX_FILE_DIFF_LINES) : lines).join("\n"),
      truncated,
      absolutePath: status === "deleted" ? null : join(worktreePath, path),
      firstLine: status === "deleted" ? null : firstLine,
    });
  }
  return files;
}

/**
 * Le travail d'une conversation comme dans une merge request : par dépôt, le
 * diff cumulé de ses commits sur les fichiers qu'ils touchent, puis ce qui
 * reste non commité dans ses propres worktrees.
 */
export async function conversationChanges(
  plan: EditorWorkspacePlan,
  commits: Array<{ repositoryPath: string; shas: string[] }>,
  ownedWorktrees: string[],
): Promise<ConversationChanges> {
  const repositories: RepositoryChanges[] = [];
  let bytes = 0;
  let truncated = false;
  const keep = (entry: RepositoryChanges) => {
    const files = entry.files.filter((file) => {
      bytes += file.diff.length;
      if (bytes > MAX_TOTAL_DIFF_BYTES) truncated = true;
      return bytes <= MAX_TOTAL_DIFF_BYTES;
    });
    if (files.length > 0) repositories.push({ ...entry, files });
  };

  for (const { repositoryPath, shas } of commits) {
    const folder = folderOfRepository(plan, repositoryPath);
    if (!folder || shas.length === 0) continue;
    const first = shas.at(-1)!;
    const parent = (await gitOutput(folder.path, ["rev-parse", "--verify", "-q", `${first}^`])).trim() || EMPTY_TREE;
    const between = Number((await gitOutput(folder.path, ["rev-list", "--count", `${parent === EMPTY_TREE ? first : parent}..${shas[0]}`])).trim())
      + (parent === EMPTY_TREE ? 1 : 0);
    const base = { repositoryLabel: folder.name, worktreePath: folder.path, branch: folder.branch, kind: "commits" as const };
    if (between === shas.length) {
      const touched = [...new Set((await gitOutput(folder.path, ["show", "--name-only", "--format=", "-M", ...shas]))
        .split("\n").filter(Boolean))];
      const diff = await gitOutput(folder.path, ["diff", "-M", "--no-color", "--no-ext-diff", parent, shas[0]!, "--", ...touched]);
      keep({ ...base, commits: shas.length, title: null, files: splitDiff(diff, folder.path) });
      continue;
    }
    for (const sha of [...shas].reverse()) {
      const [short = sha.slice(0, 9), subject = ""] = (await gitOutput(folder.path, ["show", "-s", "--format=%h%x00%s", sha])).trim().split("\0");
      const diff = await gitOutput(folder.path, ["show", "-M", "--no-color", "--no-ext-diff", "--format=", sha]);
      keep({ ...base, commits: 1, title: `${short} · ${subject}`, files: splitDiff(diff, folder.path) });
    }
  }

  const owned = new Set(ownedWorktrees);
  for (const folder of plan.folders) {
    if (!owned.has(folder.path)) continue;
    let diff = await gitOutput(folder.path, ["diff", "-M", "--no-color", "--no-ext-diff", "HEAD"]);
    const untracked = (await gitOutput(folder.path, ["ls-files", "-o", "--exclude-standard"])).split("\n").filter(Boolean);
    for (const path of untracked.slice(0, MAX_UNTRACKED_FILES)) {
      diff += await gitOutput(folder.path, ["diff", "--no-index", "--no-color", "--", "/dev/null", path], [0, 1]);
    }
    keep({
      repositoryLabel: folder.name,
      worktreePath: folder.path,
      branch: folder.branch,
      kind: "uncommitted",
      commits: 0,
      title: null,
      files: splitDiff(diff, folder.path),
    });
  }
  return { repositories, truncated };
}

/** Commits que montre la carte de la conversation (les siens, sinon ceux de son ticket) et worktrees qui lui appartiennent. */
export async function conversationWork(
  explorer: CodeExplorerService | undefined,
  projectId: string,
  conversation: Conversation,
  plan: EditorWorkspacePlan,
  sources: CodeSource[],
): Promise<{ commits: Array<{ repositoryPath: string; shas: string[] }>; owned: string[] }> {
  const work = explorer ? await explorer.conversationCommits(projectId, conversation.id).catch(() => null) : null;
  const repositories = work && work.total > 0 ? work.repositories : work?.ticket?.repositories ?? [];
  return {
    commits: repositories.map((repository) => ({
      repositoryPath: repository.repositoryPath,
      shas: repository.commits.map((entry) => entry.sha),
    })),
    owned: [
      ...conversationWorktrees(conversation),
      ...plan.folders
        .filter((folder) => folder.location && !sources.some((source) => source.main && source.path === folder.path))
        .map((folder) => folder.path),
    ],
  };
}
