import type { Database } from "bun:sqlite";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import type { ChildProcess } from "node:child_process";
import { spawnGroup, killGroup } from "./process-group";
import type { ProjectStore } from "./stores/projects";
import { projectCwd } from "./workspace";
import { parseListeningSockets } from "./running-applications";

export interface LaunchCommand {
  id: string;
  project_id: string;
  name: string;
  command: string;
  cwd_relative: string;
  env_json: string;
  port: number | null;
  url: string | null;
  kind: "run" | "deploy";
  position: number;
}
export interface LaunchSuggestion {
  name: string;
  command: string;
  frequency?: number;
}
export function historyLaunchSuggestions(
  events: Array<{ conversationId: string; payload: string }>,
): LaunchSuggestion[] {
  const found = new Map<string, Set<string>>();
  for (const row of events) {
    try {
      const event = JSON.parse(row.payload);
      const command = event.input?.command ?? event.arguments?.command;
      if (
        !["tool-start", "tool-call"].includes(event.type) ||
        typeof command !== "string"
      )
        continue;
      if (
        !/\b(?:bun run dev|npm (?:run dev|start)|pnpm dev|cargo run|vite|uvicorn|docker compose up)\b/.test(
          command,
        )
      )
        continue;
      const ids = found.get(command) ?? new Set<string>();
      ids.add(row.conversationId);
      found.set(command, ids);
    } catch {}
  }
  return [...found]
    .map(([command, ids]) => ({
      name: "Depuis les conversations",
      command,
      frequency: ids.size,
    }))
    .sort((a, b) => b.frequency - a.frequency);
}
export function detectLaunchCommands(root: string): LaunchSuggestion[] {
  const result: LaunchSuggestion[] = [];
  const read = (file: string) =>
    existsSync(join(root, file)) ? readFileSync(join(root, file), "utf8") : "";
  try {
    const scripts = JSON.parse(read("package.json") || "{}").scripts ?? {};
    const runner =
      existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb"))
        ? "bun"
        : existsSync(join(root, "pnpm-lock.yaml"))
          ? "pnpm"
          : "npm";
    for (const name of ["dev", "start", "serve"])
      if (typeof scripts[name] === "string")
        result.push({ name, command: `${runner} run ${name}` });
  } catch {}
  if (read("Cargo.toml")) result.push({ name: "Rust", command: "cargo run" });
  if (read("docker-compose.yml") || read("compose.yml"))
    result.push({ name: "Docker Compose", command: "docker compose up" });
  for (const name of ["run", "dev", "serve"])
    if (new RegExp(`^${name}\\s*:`, "m").test(read("Makefile")))
      result.push({ name: `Make ${name}`, command: `make ${name}` });
  for (const line of read("Procfile").split("\n")) {
    const match = line.match(/^([\w-]+):\s*(.+)$/);
    if (match) result.push({ name: match[1]!, command: match[2]! });
  }
  return result;
}

export class ProjectLaunchService {
  private lastOptions = new Map<
    string,
    { conversationId?: string; port?: number }
  >();
  private running = new Map<
    string,
    { child: ChildProcess; cwd: string; startedAt: string; port: number | null }
  >();
  constructor(
    private db: Database,
    private projects: ProjectStore,
    private dataDir: string,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS project_launch_commands (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL, command TEXT NOT NULL, cwd_relative TEXT NOT NULL DEFAULT '.', env_json TEXT NOT NULL DEFAULT '{}',
      port INTEGER, url TEXT, kind TEXT NOT NULL CHECK(kind IN ('run','deploy')), position INTEGER NOT NULL DEFAULT 0,
      UNIQUE(project_id, name))`);
    mkdirSync(join(dataDir, "launch-logs"), { recursive: true });
  }
  list(projectId: string): LaunchCommand[] {
    return this.db
      .query(
        "SELECT * FROM project_launch_commands WHERE project_id = ? ORDER BY position, name",
      )
      .all(projectId) as LaunchCommand[];
  }
  get(id: string): LaunchCommand {
    const row = this.db
      .query("SELECT * FROM project_launch_commands WHERE id = ?")
      .get(id) as LaunchCommand | null;
    if (!row) throw new Error("commande inconnue");
    return row;
  }
  save(projectId: string, input: Partial<LaunchCommand>): LaunchCommand {
    if (!this.projects.get(projectId)) throw new Error("projet inconnu");
    if (!input.name?.trim() || !input.command?.trim())
      throw new Error("nom et commande requis");
    this.checkPort(input.port ?? null);
    if (input.kind && !["run", "deploy"].includes(input.kind))
      throw new Error("type invalide");
    const env = JSON.parse(input.env_json ?? "{}");
    if (env?.PORT !== undefined) this.checkPort(Number(env.PORT));
    if (/(?:--port[= ]+|PORT=)(?:4820|4821)\b/.test(input.command))
      throw new Error("port réservé à Pupitre");
    if (
      !env ||
      Array.isArray(env) ||
      typeof env !== "object" ||
      Object.entries(env).some(
        ([key, value]) =>
          !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string",
      )
    )
      throw new Error("environnement invalide");
    const id = input.id ?? crypto.randomUUID();
    if (input.id && this.get(id).project_id !== projectId)
      throw new Error("commande d’un autre projet");
    if (this.running.has(id))
      throw new Error("arrêtez la commande avant modification");
    this.db
      .query(
        `INSERT INTO project_launch_commands VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, command=excluded.command, cwd_relative=excluded.cwd_relative,
      env_json=excluded.env_json, port=excluded.port, url=excluded.url, kind=excluded.kind, position=excluded.position`,
      )
      .run(
        id,
        projectId,
        input.name.trim(),
        input.command.trim(),
        input.cwd_relative ?? ".",
        JSON.stringify(env),
        input.port ?? null,
        input.url ?? null,
        input.kind ?? "run",
        input.position ?? 0,
      );
    return this.get(id);
  }
  delete(id: string) {
    if (this.running.has(id))
      throw new Error("arrêtez la commande avant suppression");
    this.db.query("DELETE FROM project_launch_commands WHERE id=?").run(id);
  }
  suggestions(projectId: string) {
    const project = this.projects.get(projectId);
    if (!project) throw new Error("projet inconnu");
    const rows = this.db
      .query(
        `SELECT e.conversation_id AS conversationId,e.payload FROM events e JOIN conversations c ON c.id=e.conversation_id WHERE c.project_id=? AND e.created_at >= ? AND e.payload LIKE '%tool-%' ORDER BY e.id DESC LIMIT 20000`,
      )
      .all(
        projectId,
        new Date(Date.now() - 60 * 86400000).toISOString(),
      ) as Array<{ conversationId: string; payload: string }>;
    return [
      ...detectLaunchCommands(projectCwd(project)),
      ...historyLaunchSuggestions(rows),
    ];
  }
  private checkPort(port: number | null) {
    if (
      port !== null &&
      (!Number.isInteger(port) ||
        port < 1 ||
        port > 65535 ||
        [4820, 4821].includes(port))
    )
      throw new Error("port invalide ou réservé à Pupitre");
  }
  private logPath(id: string) {
    this.get(id);
    return join(this.dataDir, "launch-logs", `${id}.log`);
  }
  logs(id: string) {
    const path = this.logPath(id);
    return existsSync(path)
      ? readFileSync(path, "utf8").split("\n").slice(-50).join("\n")
      : "";
  }
  status(id: string) {
    const command = this.get(id);
    const run = this.running.get(id);
    return {
      ...command,
      running: !!run,
      pid: run?.child.pid ?? null,
      cwd: run?.cwd,
      url: run?.port ? `http://localhost:${run.port}` : command.url,
      logs: this.logs(id),
    };
  }
  statuses() {
    return (
      this.db.query("SELECT id FROM project_launch_commands").all() as {
        id: string;
      }[]
    ).map(({ id }) => this.status(id));
  }
  conflict(id: string, port?: number) {
    const value = port ?? this.get(id).port;
    if (!value) return null;
    this.checkPort(value);
    return (
      parseListeningSockets(
        Bun.spawnSync(["ss", "-ltnpH"], {
          stdout: "pipe",
          stderr: "pipe",
        }).stdout.toString(),
      ).find((socket) => socket.port === value) ?? null
    );
  }
  async launch(
    id: string,
    options: {
      conversationId?: string;
      port?: number;
      replacePid?: number;
    } = {},
  ) {
    const command = this.get(id);
    if (this.running.has(id)) throw new Error("commande déjà lancée");
    const project = this.projects.get(command.project_id)!;
    let root = projectCwd(project);
    if (options.conversationId) {
      const conversation = this.db
        .query("SELECT project_id,worktree_path FROM conversations WHERE id=?")
        .get(options.conversationId) as {
        project_id: string;
        worktree_path: string | null;
      } | null;
      if (!conversation || conversation.project_id !== project.id)
        throw new Error("conversation d’un autre projet");
      root = conversation.worktree_path ?? root;
    }
    root = realpathSync(root);
    const cwd = realpathSync(resolve(root, command.cwd_relative));
    if (relative(root, cwd).startsWith(".."))
      throw new Error("répertoire hors du projet");
    const port = options.port ?? command.port;
    this.checkPort(port);
    if (port) {
      const sockets = parseListeningSockets(
        Bun.spawnSync(["ss", "-ltnpH"], {
          stdout: "pipe",
          stderr: "pipe",
        }).stdout.toString(),
      );
      const owner = sockets.find((socket) => socket.port === port);
      if (owner) {
        if (options.replacePid !== owner.pid || owner.pid === process.pid)
          throw new Error(
            `Port ${port} occupé par ${owner.process} (PID ${owner.pid}). Choisissez un autre port.`,
          );
        process.kill(owner.pid, "SIGTERM");
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (this.conflict(id, port))
          throw new Error("le port est toujours occupé après l’arrêt");
      }
    }
    this.lastOptions.set(id, {
      conversationId: options.conversationId,
      port: options.port,
    });
    const child = spawnGroup("/bin/sh", ["-c", command.command], {
      cwd,
      env: {
        ...process.env,
        ...JSON.parse(command.env_json),
        ...(port ? { PORT: String(port) } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const path = this.logPath(id);
    const append = (data: Buffer | string) => {
      if (existsSync(path) && statSync(path).size >= 5 * 1024 * 1024)
        renameSync(path, `${path}.1`);
      appendFileSync(path, data);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const run = { child, cwd, port, startedAt: new Date().toISOString() };
    this.running.set(id, run);
    child.on("error", (error) => {
      append(error.message);
      this.running.delete(id);
    });
    child.on("exit", (code) => {
      append(`\nFin : ${code}\n`);
      killGroup(child);
      if (this.running.get(id) === run) this.running.delete(id);
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    return this.status(id);
  }
  async stop(id: string) {
    const run = this.running.get(id);
    if (!run) return this.status(id);
    killGroup(run.child);
    await new Promise((resolve) => setTimeout(resolve, 250));
    killGroup(run.child, "SIGKILL");
    this.running.delete(id);
    return this.status(id);
  }
  async close() {
    await Promise.all([...this.running.keys()].map((id) => this.stop(id)));
  }
  async handle(request: Request, pathname: string): Promise<Response | null> {
    const match = pathname.match(
      /^\/api\/projects\/([^/]+)\/launch(?:\/([^/]+))?(?:\/(stop|restart|conflict))?$/,
    );
    if (pathname === "/api/launches" && request.method === "GET")
      return Response.json(this.statuses());
    const conversationMatch = pathname.match(
      /^\/api\/conversations\/([^/]+)\/launch-command$/,
    );
    if (conversationMatch && request.method === "POST") {
      try {
        const conversation = this.db
          .query(
            "SELECT project_id FROM conversations WHERE id=? AND deleted_at IS NULL",
          )
          .get(conversationMatch[1]!) as { project_id: string } | null;
        if (!conversation) throw new Error("conversation inconnue");
        const body = (await request.json()) as { name: string };
        const command = this.list(conversation.project_id).find(
          (item) => item.name === body.name,
        );
        if (!command) throw new Error("commande inconnue");
        return Response.json(
          await this.launch(command.id, {
            conversationId: conversationMatch[1]!,
          }),
        );
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 400 });
      }
    }
    if (!match) return null;
    const [, projectId, id, action] = match;
    try {
      if (id && id !== "suggestions" && this.get(id).project_id !== projectId)
        throw new Error("commande d’un autre projet");
      if (request.method === "GET")
        return Response.json(
          id === "suggestions"
            ? this.suggestions(projectId!)
            : id
              ? action === "conflict"
                ? this.conflict(
                    id,
                    new URL(request.url).searchParams.has("port")
                      ? Number(new URL(request.url).searchParams.get("port"))
                      : undefined,
                  )
                : this.status(id)
              : this.list(projectId!),
        );
      if (request.method === "PUT")
        return Response.json(
          this.save(projectId!, {
            ...((await request.json()) as object),
            ...(id ? { id } : {}),
          }),
        );
      if (request.method === "DELETE" && id) {
        this.delete(id);
        return Response.json({ ok: true });
      }
      if (request.method === "POST" && id) {
        if (action) await this.stop(id);
        return Response.json(
          action === "stop"
            ? this.status(id)
            : await this.launch(id, {
                ...(action === "restart" ? this.lastOptions.get(id) : {}),
                ...((await request.json()) as object),
              }),
        );
      }
      return Response.json({ error: "méthode inconnue" }, { status: 405 });
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 400 });
    }
  }
}
