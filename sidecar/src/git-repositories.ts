import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "build", "vendor", "coverage", "target"]);
const SHA = /^[0-9a-f]{40,64}$/i;
const BRANCH_TICKET = /(?:^|[/_-])([A-Za-z]{2,10})-(\d{3,})(?=$|[/_-])/;
const PATH_TICKET = /(?:^|-)([A-Za-z]{2,10})-?(\d{4,})(?=$|-)/;

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Dépôts d'un projet : la racine si elle est versionnée, puis les dépôts
 * imbriqués (dossier `.git`). Un dossier dont `.git` est un fichier est un
 * worktree, retrouvé par son dépôt d'origine : on ne le parcourt pas.
 */
export function discoverRepositories(projectPath: string, maxDepth = 3): string[] {
  const root = resolve(projectPath);
  const found: string[] = [];
  const visit = (directory: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    const dotGit = entries.find((entry) => entry.name === ".git");
    if (dotGit?.isDirectory()) found.push(directory);
    if ((dotGit && directory !== root) || depth >= maxDepth) return;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || SKIPPED_DIRECTORIES.has(entry.name)) continue;
      visit(join(directory, entry.name), depth + 1);
    }
  };
  visit(root, 0);
  const hasRoot = found[0] === root;
  const nested = found.slice(hasRoot ? 1 : 0).sort((left, right) => left.localeCompare(right));
  return hasRoot ? [root, ...nested] : nested;
}

interface GitDirectories {
  gitDir: string;
  commonDir: string;
}

function gitDirectories(worktreePath: string): GitDirectories | null {
  const dotGit = join(worktreePath, ".git");
  let stats;
  try {
    stats = statSync(dotGit);
  } catch {
    return null;
  }
  let gitDir = dotGit;
  if (stats.isFile()) {
    const pointer = readText(dotGit)?.match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
    if (!pointer) return null;
    gitDir = resolve(worktreePath, pointer);
  }
  const common = readText(join(gitDir, "commondir"))?.trim();
  return { gitDir, commonDir: common ? resolve(gitDir, common) : gitDir };
}

export function repositoryOfWorktree(worktreePath: string): string | null {
  const directories = gitDirectories(resolve(worktreePath));
  return directories ? dirname(directories.commonDir) : null;
}

/** Le dépôt lui-même puis ses worktrees liés encore présents sur le disque. */
export function listWorktreePaths(repositoryPath: string): string[] {
  const root = resolve(repositoryPath);
  const paths = [root];
  const worktreesDirectory = join(root, ".git", "worktrees");
  let names: string[];
  try {
    names = readdirSync(worktreesDirectory);
  } catch {
    return paths;
  }
  for (const name of names) {
    const pointer = readText(join(worktreesDirectory, name, "gitdir"))?.trim();
    if (!pointer) continue;
    const worktree = dirname(resolve(worktreesDirectory, name, pointer));
    if (existsSync(join(worktree, ".git"))) paths.push(worktree);
  }
  return paths;
}

function readRef(directories: GitDirectories, ref: string): string | null {
  for (const base of [directories.gitDir, directories.commonDir]) {
    const value = readText(join(base, ref))?.trim();
    if (value && SHA.test(value)) return value;
  }
  const packed = readText(join(directories.commonDir, "packed-refs"));
  for (const line of packed?.split("\n") ?? []) {
    const [sha, name] = line.split(" ");
    if (name === ref && sha && SHA.test(sha)) return sha;
  }
  return null;
}

/** HEAD lu dans les fichiers de Git, sans lancer de processus. `sha` est nul sur une branche sans commit. */
export function readHead(worktreePath: string): { sha: string | null; branch: string | null } {
  const directories = gitDirectories(resolve(worktreePath));
  const head = directories ? readText(join(directories.gitDir, "HEAD"))?.trim() : null;
  if (!directories || !head) return { sha: null, branch: null };
  if (SHA.test(head)) return { sha: head, branch: null };
  const ref = head.match(/^ref:\s*(.+)$/)?.[1];
  if (!ref) return { sha: null, branch: null };
  return { sha: readRef(directories, ref), branch: ref.replace(/^refs\/heads\//, "") };
}

/** SHAs des branches distantes connues localement. */
export function readRemoteRefs(repositoryPath: string): string[] {
  const directories = gitDirectories(resolve(repositoryPath));
  if (!directories) return [];
  const shas = new Set<string>();
  const walk = (directory: string) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else {
        const value = readText(path)?.trim();
        if (value && SHA.test(value)) shas.add(value);
      }
    }
  };
  walk(join(directories.commonDir, "refs", "remotes"));
  for (const line of readText(join(directories.commonDir, "packed-refs"))?.split("\n") ?? []) {
    const [sha, name] = line.split(" ");
    if (name?.startsWith("refs/remotes/") && sha && SHA.test(sha)) shas.add(sha);
  }
  return [...shas];
}

export function ticketKeyOf(branch: string | null, path: string | null = null): string | null {
  const fromBranch = branch?.match(BRANCH_TICKET);
  if (fromBranch) return `${fromBranch[1]!.toUpperCase()}-${fromBranch[2]}`;
  const fromPath = (path ? basename(path) : "").match(PATH_TICKET);
  return fromPath ? `${fromPath[1]!.toUpperCase()}-${fromPath[2]}` : null;
}
