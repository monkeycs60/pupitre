import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { CodeSource } from "./code-explorer";
import { readHead, ticketKeyOf } from "./git-repositories";
import type { Conversation } from "./stores/conversations";
import type { Project } from "./stores/projects";
import { conversationWorktrees } from "./workspace";

export class EditorWorkspaceError extends Error {}

export interface EditorFolder {
  name: string;
  path: string;
  branch: string | null;
}

export interface EditorWorkspacePlan {
  /** Fichier `.code-workspace` à écrire, ou nul quand un seul dossier suffit. */
  workspace: { fileName: string; content: Record<string, unknown> } | null;
  folders: EditorFolder[];
}

interface WorkspaceTemplate {
  folders: Array<{ path: string; name?: string }>;
  rest: Record<string, unknown>;
}

function readTemplate(directory: string, projectName: string): WorkspaceTemplate | null {
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith(".code-workspace")).sort();
  } catch {
    return null;
  }
  const name = names.find((candidate) => candidate === `${projectName}.code-workspace`) ?? names[0];
  if (!name) return null;
  try {
    const parsed = JSON.parse(readFileSync(join(directory, name), "utf8")) as Record<string, unknown>;
    const { folders, ...rest } = parsed;
    if (!Array.isArray(folders)) return null;
    return {
      folders: folders.filter((folder): folder is { path: string; name?: string } =>
        typeof folder === "object" && folder !== null && typeof (folder as { path?: unknown }).path === "string"),
      rest,
    };
  } catch {
    return null;
  }
}

/**
 * Choisit, pour chaque dépôt du projet, le worktree de la conversation : le
 * sien d'abord, puis celui qui porte la même branche, puis celui de son
 * ticket, sinon le dépôt principal.
 */
export function planEditorWorkspace(
  project: Project,
  conversation: Conversation,
  sources: CodeSource[],
): EditorWorkspacePlan {
  const projectPath = resolve(project.path);
  const projectName = basename(projectPath);
  const owned = conversationWorktrees(conversation).map((path) => resolve(path)).filter((path) => existsSync(path));
  const branch = conversation.worktree_path ? readHead(conversation.worktree_path).branch : null;
  const key = conversation.ticket_key ?? ticketKeyOf(branch, conversation.worktree_path);
  const worktrees = sources.filter((source) => source.ref === null);
  const repositories = [...new Set(worktrees.map((source) => source.repositoryPath))];

  const choose = (repositoryPath: string): CodeSource | null => {
    const candidates = worktrees.filter((source) => source.repositoryPath === repositoryPath);
    const ownedSource = candidates.find((source) => owned.includes(source.path));
    if (ownedSource) return ownedSource;
    const byBranch = branch ? candidates.find((source) => !source.main && source.branch === branch) : undefined;
    if (byBranch) return byBranch;
    const byTicket = key
      ? candidates
        .filter((source) => !source.main && !/-before$/i.test(source.path) && ticketKeyOf(source.branch, source.path) === key)
        .sort((left, right) => Number(left.branch === null) - Number(right.branch === null))[0]
      : undefined;
    return byTicket ?? candidates.find((source) => source.main) ?? null;
  };

  const rootSource = choose(projectPath);
  const root: EditorFolder = {
    name: projectName,
    path: rootSource?.path ?? resolve(conversation.worktree_path ?? projectPath),
    branch: rootSource?.branch ?? branch,
  };
  const nested = new Map<string, EditorFolder>();
  for (const repositoryPath of repositories) {
    if (repositoryPath === projectPath) continue;
    const chosen = choose(repositoryPath);
    if (chosen) nested.set(repositoryPath, { name: basename(repositoryPath), path: chosen.path, branch: chosen.branch });
  }

  const template = readTemplate(root.path, projectName) ?? readTemplate(projectPath, projectName);
  const folders: EditorFolder[] = [];
  const placed = new Set<string>();
  if (template) {
    for (const folder of template.folders) {
      const target = resolve(projectPath, folder.path);
      if (target === projectPath) {
        folders.push(root);
        placed.add(projectPath);
        continue;
      }
      const repository = nested.get(target);
      if (repository) {
        folders.push(folder.name ? { ...repository, name: folder.name } : repository);
        placed.add(target);
      } else if (existsSync(target)) {
        folders.push({ name: folder.name ?? basename(target), path: target, branch: null });
      }
    }
    if (!placed.has(projectPath)) folders.unshift(root);
  } else {
    folders.push(root);
  }
  for (const [repositoryPath, folder] of nested) {
    const ownBranch = folder.path !== repositoryPath;
    if (!placed.has(repositoryPath) && ownBranch) folders.push(folder);
  }

  if (folders.length === 1 && !template) return { workspace: null, folders };
  const label = (branch ?? key ?? conversation.id.slice(0, 8)).replace(/[^\w.-]+/g, "-");
  return {
    workspace: {
      fileName: `${projectName}-${label}.code-workspace`,
      content: {
        folders: folders.map((folder) => ({ name: folder.name, path: folder.path })),
        ...(template?.rest ?? {}),
      },
    },
    folders,
  };
}

function editorCommand(): string {
  const candidates = [
    Bun.which("code"),
    join(homedir(), ".local/bin/code"),
    "/usr/bin/code",
    "/usr/local/bin/code",
    "/snap/bin/code",
    "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
  ];
  const found = candidates.find((candidate): candidate is string => !!candidate && existsSync(candidate));
  if (!found) throw new EditorWorkspaceError("commande `code` introuvable : installe la CLI de VS Code");
  return found;
}

/** Ouvre VS Code dans une nouvelle fenêtre ; les fenêtres déjà ouvertes ne bougent pas. */
export function openEditorWorkspace(plan: EditorWorkspacePlan, directory: string): { target: string } {
  const command = editorCommand();
  let target = plan.folders[0]!.path;
  if (plan.workspace) {
    mkdirSync(directory, { recursive: true });
    target = join(directory, plan.workspace.fileName);
    writeFileSync(target, `${JSON.stringify(plan.workspace.content, null, 2)}\n`);
  }
  Bun.spawn([command, "--new-window", target], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
  return { target };
}
