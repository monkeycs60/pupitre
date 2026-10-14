import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import type { CodeSource } from "./code-explorer";
import { readHead, repositoryOfWorktree, ticketKeyOf } from "./git-repositories";
import type { Conversation } from "./stores/conversations";
import type { Project } from "./stores/projects";
import { conversationWorktrees } from "./workspace";

export class EditorWorkspaceError extends Error {}

export interface EditorFolder {
  name: string;
  path: string;
  branch: string | null;
  /** Emplacement du dépôt dans le projet (`apps/reactor`, `""` pour la racine), nul pour un simple dossier. */
  location?: string | null;
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
    location: "",
  };
  const nested = new Map<string, EditorFolder>();
  for (const repositoryPath of repositories) {
    if (repositoryPath === projectPath) continue;
    const chosen = choose(repositoryPath);
    if (chosen) nested.set(repositoryPath, {
      name: basename(repositoryPath),
      path: chosen.path,
      branch: chosen.branch,
      location: relative(projectPath, repositoryPath).split(sep).join("/"),
    });
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

function writeWorkspace(plan: EditorWorkspacePlan, directory: string): string {
  if (!plan.workspace) return plan.folders[0]!.path;
  mkdirSync(directory, { recursive: true });
  const target = join(directory, plan.workspace.fileName);
  writeFileSync(target, `${JSON.stringify(plan.workspace.content, null, 2)}\n`);
  return target;
}

/** Ouvre VS Code dans une nouvelle fenêtre ; les fenêtres déjà ouvertes ne bougent pas. */
export function openEditorWorkspace(plan: EditorWorkspacePlan, directory: string): { target: string } {
  const command = editorCommand();
  const target = writeWorkspace(plan, directory);
  Bun.spawn([command, "--new-window", target], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
  return { target };
}

function vscodeStoragePath(): string {
  if (process.platform === "darwin") return join(homedir(), "Library/Application Support/Code/User/globalStorage/storage.json");
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "Code/User/globalStorage/storage.json");
}

/** Dossiers et fichiers `.code-workspace` des fenêtres VS Code ouvertes, d'après l'état que VS Code tient à jour. */
export function openEditorWindows(storagePath = vscodeStoragePath()): Set<string> {
  const opened = new Set<string>();
  let state: { windowsState?: { lastActiveWindow?: unknown; openedWindows?: unknown[] } };
  try {
    state = JSON.parse(readFileSync(storagePath, "utf8"));
  } catch {
    return opened;
  }
  const windows = [state.windowsState?.lastActiveWindow, ...(state.windowsState?.openedWindows ?? [])];
  for (const window of windows) {
    if (typeof window !== "object" || window === null) continue;
    const { folder, workspaceIdentifier } = window as { folder?: unknown; workspaceIdentifier?: { configURIPath?: unknown } };
    for (const uri of [folder, workspaceIdentifier?.configURIPath]) {
      if (typeof uri !== "string" || !uri.startsWith("file://")) continue;
      try {
        opened.add(resolve(decodeURIComponent(new URL(uri).pathname)));
      } catch {
        // URI illisible : la fenêtre est ignorée.
      }
    }
  }
  return opened;
}

export interface EditorFileTarget {
  path: string;
  line: number | null;
}

/**
 * Une fenêtre VS Code par worktree : chaque fichier s'ouvre en onglet dans la
 * fenêtre de la conversation si elle est ouverte, sinon dans une fenêtre déjà
 * ouverte sur son worktree, sinon dans une nouvelle fenêtre de la conversation.
 * Un fichier d'un worktree étranger à la conversation (`otherWorktrees`) ouvre
 * la fenêtre de ce worktree.
 */
export function openEditorFiles(
  plan: EditorWorkspacePlan,
  files: EditorFileTarget[],
  directory: string,
  otherWorktrees: string[] = [],
  windows = openEditorWindows(),
): { targets: string[] } {
  const command = editorCommand();
  const conversationTarget = writeWorkspace(plan, directory);
  const groups = new Map<string, string[]>();
  for (const file of files) {
    const path = resolve(file.path);
    let target = conversationTarget;
    const worktree = plan.folders
      .filter((folder) => path.startsWith(`${folder.path}/`))
      .sort((left, right) => right.path.length - left.path.length)[0]?.path
      ?? otherWorktrees
        .filter((other) => path.startsWith(`${other}/`))
        .sort((left, right) => right.length - left.length)[0];
    const foreign = worktree !== undefined && !plan.folders.some((folder) => folder.path === worktree);
    if (foreign || !windows.has(conversationTarget)) {
      const owner = [...windows]
        .filter((opened) => path.startsWith(`${opened}/`))
        .sort((left, right) => right.length - left.length)[0];
      if (owner && (!worktree || owner.length >= worktree.length)) target = owner;
      else if (foreign) target = worktree;
    }
    const list = groups.get(target) ?? [];
    list.push(file.line ? `${path}:${file.line}` : path);
    groups.set(target, list);
  }
  for (const [target, paths] of groups) {
    Bun.spawn([command, target, "--goto", ...paths], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
  }
  return { targets: [...groups.keys()] };
}

export const MAX_CHANGED_FILES_OPENED = 10;
const GENERATED_FILE = /(?:^|\/)(?:dist|build)\/|(?:\.lock|-lock\.json|\.snap)$/;

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
  const output = await new Response(child.stdout).text();
  return (await child.exited) === 0 ? output : "";
}

/** Fichier → première ligne modifiée, dans l'ordre du diff ; le premier diff qui cite un fichier l'emporte. */
function firstChangedLines(diff: string, into: Map<string, number | null>): void {
  let current: string | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const path = line.match(/ b\/(.+)$/)?.[1] ?? null;
      current = path !== null && !into.has(path) ? path : null;
      if (current !== null) into.set(current, null);
    } else if (current !== null && line.startsWith("@@ ")) {
      const start = Number(line.match(/\+(\d+)/)?.[1] ?? 0);
      into.set(current, Math.max(1, start));
      current = null;
    }
  }
}

/**
 * Fichiers modifiés par le travail d'une conversation, dans les dossiers de sa
 * fenêtre VS Code : les changements non commités de ses propres worktrees,
 * puis ceux de ses commits, du plus récent au plus ancien.
 */
export async function changedFiles(
  plan: EditorWorkspacePlan,
  commits: Array<{ repositoryPath: string; shas: string[] }>,
  ownedWorktrees: string[],
): Promise<EditorFileTarget[]> {
  const owned = new Set(ownedWorktrees.map((path) => resolve(path)));
  const found: EditorFileTarget[] = [];
  const seen = new Set<string>();
  const collect = (folder: string, lines: Map<string, number | null>) => {
    for (const [path, line] of lines) {
      const absolute = join(folder, path);
      if (seen.has(absolute) || GENERATED_FILE.test(path) || !existsSync(absolute)) continue;
      seen.add(absolute);
      found.push({ path: absolute, line });
    }
  };

  for (const folder of plan.folders) {
    if (!owned.has(folder.path)) continue;
    const lines = new Map<string, number | null>();
    firstChangedLines(await gitOutput(folder.path, ["diff", "-U0", "--no-color", "--no-ext-diff", "HEAD"]), lines);
    for (const path of (await gitOutput(folder.path, ["ls-files", "-o", "--exclude-standard"])).split("\n")) {
      if (path && !lines.has(path)) lines.set(path, null);
    }
    collect(folder.path, lines);
  }

  for (const { repositoryPath, shas } of commits) {
    if (shas.length === 0) continue;
    const folder = plan.folders.find((candidate) => candidate.location !== undefined && candidate.location !== null
      && repositoryOfWorktree(candidate.path) === resolve(repositoryPath));
    if (!folder) continue;
    const lines = new Map<string, number | null>();
    firstChangedLines(await gitOutput(folder.path, ["show", "-U0", "--no-color", "--no-ext-diff", "-M", "--format=", ...shas]), lines);
    collect(folder.path, lines);
  }
  return found;
}
