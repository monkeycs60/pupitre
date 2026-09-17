import { existsSync, readFileSync, readlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export interface ApplicationContext {
  projectId: string;
  projectName: string;
  root: string;
  kind: "project" | "worktree";
}

export interface RunningApplication {
  id: string;
  name: string;
  projectId: string;
  projectName: string;
  workspace: string;
  branch: string | null;
  cwd: string;
  process: string;
  pid: number;
  port: number;
  url: string;
}

interface ListeningSocket {
  pid: number;
  port: number;
  process: string;
}

export function parseListeningSockets(output: string): ListeningSocket[] {
  const sockets: ListeningSocket[] = [];
  const seen = new Set<string>();
  for (const line of output.split("\n")) {
    const localAddress = line.trim().split(/\s+/u)[3];
    const port = Number(localAddress?.match(/:(\d+)$/u)?.[1]);
    const pid = Number(line.match(/pid=(\d+)/u)?.[1]);
    const process = line.match(/users:\(\("([^"]+)/u)?.[1];
    const id = `${pid}:${port}`;
    if (!Number.isInteger(port) || !Number.isInteger(pid) || !process || seen.has(id)) continue;
    seen.add(id);
    sockets.push({ pid, port, process });
  }
  return sockets;
}

export function inspectorPort(command: string): number | null {
  const value = command.match(/(?:^|\s)--inspect(?:-brk)?(?:=([^\s]+))?(?:\s|$)/u)?.[1];
  if (value === undefined) return command.includes("--inspect") ? 9_229 : null;
  const port = Number(/^\d+$/u.test(value) ? value : value.match(/:(\d+)$/u)?.[1] ?? 9_229);
  return Number.isInteger(port) ? port : null;
}

function isInside(path: string, root: string): boolean {
  const relative = path.slice(root.length);
  return path === root || (path.startsWith(root) && relative.startsWith("/"));
}

export function contextForCwd(cwd: string, contexts: ApplicationContext[]): ApplicationContext | null {
  return contexts
    .filter((context) => isInside(cwd, context.root))
    .sort((left, right) => right.root.length - left.root.length)[0] ?? null;
}

function packageName(cwd: string, boundary: string): string | null {
  let directory = cwd;
  while (isInside(directory, boundary)) {
    const path = join(directory, "package.json");
    if (existsSync(path)) {
      try {
        const value = JSON.parse(readFileSync(path, "utf8")) as { name?: unknown };
        if (typeof value.name === "string" && value.name.trim()) return value.name.trim();
      } catch {}
    }
    if (directory === boundary) break;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

function currentBranch(cwd: string): string | null {
  const result = Bun.spawnSync(["git", "-C", cwd, "branch", "--show-current"], {
    stderr: "ignore",
  });
  if (result.exitCode !== 0) return null;
  return result.stdout.toString().trim() || null;
}

export function listRunningApplications(contexts: ApplicationContext[]): RunningApplication[] {
  const result = Bun.spawnSync(["ss", "-ltnpH"]);
  if (result.exitCode !== 0) return [];

  const normalizedContexts = contexts.map((context) => ({
    ...context,
    root: resolve(context.root),
  }));
  const cwdCache = new Map<number, string | null>();
  const commandCache = new Map<number, string>();
  const branchCache = new Map<string, string | null>();

  return parseListeningSockets(result.stdout.toString())
    .flatMap((socket): RunningApplication[] => {
      if (socket.process === "code") return [];
      let cwd = cwdCache.get(socket.pid);
      if (cwd === undefined) {
        try { cwd = readlinkSync(`/proc/${socket.pid}/cwd`); } catch { cwd = null; }
        cwdCache.set(socket.pid, cwd);
      }
      if (!cwd) return [];
      const context = contextForCwd(cwd, normalizedContexts);
      if (!context) return [];
      let command = commandCache.get(socket.pid);
      if (command === undefined) {
        try { command = readFileSync(`/proc/${socket.pid}/cmdline`, "utf8").replaceAll("\0", " "); } catch { command = ""; }
        commandCache.set(socket.pid, command);
      }
      if (inspectorPort(command) === socket.port) return [];

      let branch = branchCache.get(cwd);
      if (branch === undefined) {
        branch = currentBranch(cwd);
        branchCache.set(cwd, branch);
      }
      const name = packageName(cwd, context.root) ?? basename(cwd) ?? socket.process;
      return [{
        id: `${socket.pid}:${socket.port}`,
        name,
        projectId: context.projectId,
        projectName: context.projectName,
        workspace: context.kind === "worktree" ? basename(context.root) : basename(cwd),
        branch,
        cwd,
        process: socket.process,
        pid: socket.pid,
        port: socket.port,
        url: `http://localhost:${socket.port}`,
      }];
    })
    .sort((left, right) => left.projectName.localeCompare(right.projectName)
      || left.name.localeCompare(right.name)
      || left.port - right.port);
}
