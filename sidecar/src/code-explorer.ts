import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import type { ProjectStore } from "./stores/projects";

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TREE_PATHS = 60_000;
const MAX_COMMIT_FILES = 500;
const GRAPH_PAGE_SIZE = 300;
const HISTORY_LIMIT = 100;
const SEARCH_LIMIT = 300;
const SEARCH_OUTPUT_BYTES = 512 * 1024;
const DISCOVERY_DEPTH = 3;
const SOURCE_CACHE_MS = 5_000;
const GIT_TIMEOUT_MS = 20_000;
const SOURCE_CONVERSATION_LIMIT = 25;
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "build", "vendor", "coverage", "target"]);
const BASE_BRANCHES = ["origin/develop", "origin/main", "origin/master", "develop", "main", "master"];
const FULL_SHA = /^[0-9a-f]{40,64}$/i;
const SHORT_SHA = /^[0-9a-f]{7,64}$/i;
const UNCOMMITTED = /^0+$/;
const LOG_FORMAT = "--format=%H%x00%P%x00%D%x00%an%x00%aI%x00%s";

export class CodeExplorerError extends Error {}

export interface CodeConversationLink {
  id: string;
  title: string;
  provider: string;
}

export interface CodeSource {
  path: string;
  repositoryPath: string;
  repositoryLabel: string;
  branch: string | null;
  head: string | null;
  detached: boolean;
  main: boolean;
  conversations: CodeConversationLink[];
}

export type CodeDirtyStatus = "M" | "A" | "D" | "R" | "?";

export interface CodeFileList {
  paths: string[];
  dirty: Array<{ path: string; status: CodeDirtyStatus }>;
  truncated: boolean;
}

export interface CodeFile {
  path: string;
  ref: string;
  content: string | null;
  size: number;
  binary: boolean;
  tooLarge: boolean;
}

export interface CodeBlameGroup {
  sha: string;
  start: number;
  count: number;
  author: string;
  authoredAt: string | null;
  summary: string;
  uncommitted: boolean;
  conversations: CodeConversationLink[];
}

export interface CodeBlame {
  path: string;
  lineCount: number;
  groups: CodeBlameGroup[];
}

export interface CodeCommitSummary {
  sha: string;
  parents: string[];
  refs: string[];
  author: string;
  authoredAt: string;
  subject: string;
  conversations: CodeConversationLink[];
}

export interface CodeGraphPage {
  head: string | null;
  currentBranch: string | null;
  base: string | null;
  focus: string[];
  commits: CodeCommitSummary[];
  skip: number;
  hasMore: boolean;
}

export interface CodeCommitFile {
  path: string;
  previousPath: string | null;
  status: string;
  added: number | null;
  removed: number | null;
}

export interface CodeCommitDetail extends CodeCommitSummary {
  email: string;
  body: string;
  files: CodeCommitFile[];
  filesTruncated: boolean;
}

export interface CodeSearchMatch {
  path: string;
  line: number;
  text: string;
}

export interface CodeSearchResult {
  query: string;
  matches: CodeSearchMatch[];
  truncated: boolean;
}

interface GitOutput {
  stdout: string;
  truncated: boolean;
}

interface GitOptions {
  accept?: number[];
  maxBytes?: number;
  truncate?: boolean;
}

async function runGit(cwd: string, args: string[], options: GitOptions = {}): Promise<GitOutput> {
  const maxBytes = options.maxBytes ?? MAX_OUTPUT_BYTES;
  const child = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  });
  const timer = setTimeout(() => child.kill(), GIT_TIMEOUT_MS);
  const stderrPromise = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > maxBytes) {
        chunks.push(value.subarray(0, maxBytes - total));
        total = maxBytes;
        truncated = true;
        child.kill();
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
    clearTimeout(timer);
  }
  const [exitCode, stderr] = await Promise.all([child.exited, stderrPromise]);
  if (truncated && !options.truncate) throw new CodeExplorerError("sortie Git trop volumineuse");
  if (!truncated && !(options.accept ?? [0]).includes(exitCode)) {
    throw new CodeExplorerError(stderr.trim() || "commande Git impossible");
  }
  return { stdout: Buffer.concat(chunks).toString("utf8"), truncated };
}

async function optionalGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    return (await runGit(cwd, args)).stdout;
  } catch {
    return null;
  }
}

function parseCommitRecords(output: string): Omit<CodeCommitSummary, "conversations">[] {
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const commits: Omit<CodeCommitSummary, "conversations">[] = [];
  for (let index = 0; index + 5 < fields.length; index += 6) {
    const [rawSha = "", rawParents = "", rawRefs = "", author = "", authoredAt = "", subject = ""] =
      fields.slice(index, index + 6);
    const sha = rawSha.replace(/^\n/, "");
    if (!FULL_SHA.test(sha)) throw new CodeExplorerError("sortie git log invalide");
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

function dirtyStatus(code: string): CodeDirtyStatus {
  if (code === "??") return "?";
  if (code.includes("D")) return "D";
  if (code.includes("R")) return "R";
  if (code.includes("A")) return "A";
  return "M";
}

export class CodeExplorerService {
  private sourceCache = new Map<string, { at: number; sources: Promise<CodeSource[]> }>();

  constructor(
    private db: Database,
    private projects: ProjectStore,
  ) {}

  sources(projectId: string): Promise<CodeSource[]> {
    const cached = this.sourceCache.get(projectId);
    if (cached && Date.now() - cached.at < SOURCE_CACHE_MS) return cached.sources;
    const sources = this.loadSources(projectId);
    this.sourceCache.set(projectId, { at: Date.now(), sources });
    sources.catch(() => this.sourceCache.delete(projectId));
    return sources;
  }

  async files(projectId: string, source: string | null): Promise<CodeFileList> {
    const cwd = await this.sourcePath(projectId, source);
    const [listed, status] = await Promise.all([
      runGit(cwd, ["ls-files", "-co", "--exclude-standard", "-z"], { truncate: true }),
      runGit(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { truncate: true }),
    ]);
    const rawPaths = listed.stdout.split("\0");
    if (listed.truncated) rawPaths.pop();
    const unique = [...new Set(rawPaths.filter(Boolean))];
    const paths = unique.slice(0, MAX_TREE_PATHS).sort((left, right) => left.localeCompare(right));
    const dirty: CodeFileList["dirty"] = [];
    const entries = status.stdout.split("\0");
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index] ?? "";
      if (entry.length < 4) continue;
      const code = entry.slice(0, 2);
      dirty.push({ path: entry.slice(3), status: dirtyStatus(code) });
      if (code.includes("R") || code.includes("C")) index += 1;
    }
    const deleted = dirty.filter((item) => item.status === "D").map((item) => item.path);
    const visible = deleted.length === 0 ? paths : paths.filter((path) => !deleted.includes(path));
    return {
      paths: visible,
      dirty,
      truncated: listed.truncated || unique.length > MAX_TREE_PATHS,
    };
  }

  async file(projectId: string, source: string | null, path: string, ref?: string | null): Promise<CodeFile> {
    const cwd = await this.sourcePath(projectId, source);
    const safe = this.safePath(cwd, path);
    const wanted = ref?.trim() || "worktree";
    if (wanted === "worktree") {
      const absolute = join(cwd, safe);
      if (!existsSync(absolute) || !statSync(absolute).isFile()) {
        throw new CodeExplorerError(`fichier introuvable : ${safe}`);
      }
      const size = statSync(absolute).size;
      if (size > MAX_FILE_BYTES) {
        return { path: safe, ref: wanted, content: null, size, binary: false, tooLarge: true };
      }
      const bytes = readFileSync(absolute);
      const binary = bytes.subarray(0, 8000).includes(0);
      return { path: safe, ref: wanted, content: binary ? null : bytes.toString("utf8"), size, binary, tooLarge: false };
    }
    if (!SHORT_SHA.test(wanted)) throw new CodeExplorerError(`référence Git invalide : ${wanted}`);
    const size = Number((await runGit(cwd, ["cat-file", "-s", `${wanted}:${safe}`])).stdout.trim());
    if (size > MAX_FILE_BYTES) {
      return { path: safe, ref: wanted, content: null, size, binary: false, tooLarge: true };
    }
    const { stdout } = await runGit(cwd, ["cat-file", "blob", `${wanted}:${safe}`]);
    const binary = stdout.slice(0, 8000).includes("\0");
    return { path: safe, ref: wanted, content: binary ? null : stdout, size, binary, tooLarge: false };
  }

  async blame(projectId: string, source: string | null, path: string): Promise<CodeBlame> {
    const cwd = await this.sourcePath(projectId, source);
    const safe = this.safePath(cwd, path);
    let output: string;
    try {
      output = (await runGit(cwd, ["blame", "--porcelain", "--", safe])).stdout;
    } catch (error) {
      const absolute = join(cwd, safe);
      if (!existsSync(absolute)) throw error;
      const lineCount = readFileSync(absolute, "utf8").split("\n").length;
      return {
        path: safe,
        lineCount,
        groups: [{
          sha: "0".repeat(40),
          start: 1,
          count: lineCount,
          author: "",
          authoredAt: null,
          summary: "",
          uncommitted: true,
          conversations: [],
        }],
      };
    }

    const meta = new Map<string, { author: string; authoredAt: string | null; summary: string }>();
    const groups: CodeBlameGroup[] = [];
    let sha = "";
    let finalLine = 0;
    let lineCount = 0;
    for (const line of output.split("\n")) {
      if (line.startsWith("\t")) {
        lineCount += 1;
        const last = groups.at(-1);
        if (last && last.sha === sha && last.start + last.count === finalLine) {
          last.count += 1;
        } else {
          const info = meta.get(sha);
          groups.push({
            sha,
            start: finalLine,
            count: 1,
            author: info?.author ?? "",
            authoredAt: info?.authoredAt ?? null,
            summary: info?.summary ?? "",
            uncommitted: UNCOMMITTED.test(sha),
            conversations: [],
          });
        }
        continue;
      }
      const header = line.match(/^([0-9a-f]{40,64}) \d+ (\d+)(?: \d+)?$/);
      if (header) {
        sha = header[1]!;
        finalLine = Number(header[2]);
        if (!meta.has(sha)) meta.set(sha, { author: "", authoredAt: null, summary: "" });
        continue;
      }
      const info = meta.get(sha);
      if (!info) continue;
      if (line.startsWith("author ")) info.author = line.slice(7);
      else if (line.startsWith("author-time ")) {
        info.authoredAt = new Date(Number(line.slice(12)) * 1000).toISOString();
      } else if (line.startsWith("summary ")) info.summary = line.slice(8);
    }
    for (const group of groups) {
      const info = meta.get(group.sha);
      if (info) Object.assign(group, info);
    }
    const links = this.links(projectId);
    for (const group of groups) group.conversations = links.get(group.sha) ?? [];
    return { path: safe, lineCount, groups };
  }

  async history(projectId: string, source: string | null, path: string): Promise<CodeCommitSummary[]> {
    const cwd = await this.sourcePath(projectId, source);
    const safe = this.safePath(cwd, path);
    const { stdout } = await runGit(cwd, [
      "log", "-z", "--follow", `--max-count=${HISTORY_LIMIT}`, LOG_FORMAT, "--", safe,
    ]);
    return this.withLinks(projectId, parseCommitRecords(stdout));
  }

  async graph(projectId: string, source: string | null, skip = 0): Promise<CodeGraphPage> {
    const cwd = await this.sourcePath(projectId, source);
    const offset = Number.isInteger(skip) && skip > 0 ? skip : 0;
    const [log, headOutput, branchOutput] = await Promise.all([
      runGit(cwd, [
        "log", "-z", "--topo-order", "--exclude=refs/stash", "--all",
        `--skip=${offset}`, `--max-count=${GRAPH_PAGE_SIZE + 1}`, LOG_FORMAT,
      ], { accept: [0, 128] }),
      optionalGit(cwd, ["rev-parse", "--verify", "-q", "HEAD"]),
      optionalGit(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]),
    ]);
    const records = parseCommitRecords(log.stdout);
    const head = headOutput?.trim() || null;
    const currentBranch = branchOutput?.trim() || null;
    let base: string | null = null;
    let focus: string[] = [];
    if (offset === 0 && head) {
      for (const candidate of BASE_BRANCHES) {
        if (candidate === currentBranch) continue;
        if (await optionalGit(cwd, ["rev-parse", "--verify", "-q", `${candidate}^{commit}`])) {
          base = candidate;
          break;
        }
      }
      if (base) {
        focus = ((await optionalGit(cwd, ["rev-list", "--max-count=500", `${base}..${head}`])) ?? "")
          .split("\n").filter(Boolean);
      }
    }
    return {
      head,
      currentBranch,
      base,
      focus,
      commits: this.withLinks(projectId, records.slice(0, GRAPH_PAGE_SIZE)),
      skip: offset,
      hasMore: records.length > GRAPH_PAGE_SIZE,
    };
  }

  async commit(projectId: string, source: string | null, sha: string): Promise<CodeCommitDetail> {
    const cwd = await this.sourcePath(projectId, source);
    if (!SHORT_SHA.test(sha)) throw new CodeExplorerError(`référence Git invalide : ${sha}`);
    const { stdout } = await runGit(cwd, [
      "show", "-s", "-z", "--format=%H%x00%P%x00%D%x00%an%x00%ae%x00%aI%x00%s%x00%b", sha,
    ]);
    const [full = "", rawParents = "", rawRefs = "", author = "", email = "", authoredAt = "", subject = "", body = ""] =
      stdout.split("\0");
    if (!FULL_SHA.test(full)) throw new CodeExplorerError(`commit introuvable : ${sha}`);
    const parents = rawParents.split(" ").filter(Boolean);
    const range = parents.length > 0 ? [parents[0]!, full] : ["--root", full];
    const [numstat, nameStatus] = await Promise.all([
      runGit(cwd, ["diff-tree", "-r", "-M", "-z", "--no-commit-id", "--numstat", ...range]),
      runGit(cwd, ["diff-tree", "-r", "-M", "-z", "--no-commit-id", "--name-status", ...range]),
    ]);

    const stats = new Map<string, { added: number | null; removed: number | null }>();
    const numFields = numstat.stdout.split("\0");
    for (let index = 0; index < numFields.length; index += 1) {
      const field = numFields[index] ?? "";
      const match = field.match(/^(-|\d+)\t(-|\d+)\t(.*)$/s);
      if (!match) continue;
      const counts = {
        added: match[1] === "-" ? null : Number(match[1]),
        removed: match[2] === "-" ? null : Number(match[2]),
      };
      if (match[3] === "") {
        stats.set(numFields[index + 2] ?? "", counts);
        index += 2;
      } else {
        stats.set(match[3]!, counts);
      }
    }

    const files: CodeCommitFile[] = [];
    const statusFields = nameStatus.stdout.split("\0").filter((field) => field !== "");
    for (let index = 0; index < statusFields.length; index += 1) {
      const status = statusFields[index] ?? "";
      if (!/^[A-Z]\d*$/.test(status)) continue;
      const renamed = status.startsWith("R") || status.startsWith("C");
      const previousPath = renamed ? statusFields[index + 1] ?? null : null;
      const path = renamed ? statusFields[index + 2] ?? "" : statusFields[index + 1] ?? "";
      index += renamed ? 2 : 1;
      const counts = stats.get(path) ?? { added: null, removed: null };
      files.push({ path, previousPath, status: status[0]!, ...counts });
    }

    const [summary] = this.withLinks(projectId, [{
      sha: full,
      parents,
      refs: rawRefs.split(",").map((ref) => ref.trim()).filter(Boolean),
      author,
      authoredAt,
      subject,
    }]);
    return {
      ...summary!,
      email,
      body: body.trim(),
      files: files.slice(0, MAX_COMMIT_FILES),
      filesTruncated: files.length > MAX_COMMIT_FILES,
    };
  }

  async diff(projectId: string, source: string | null, sha: string, path: string): Promise<{ diff: string }> {
    const cwd = await this.sourcePath(projectId, source);
    if (!SHORT_SHA.test(sha)) throw new CodeExplorerError(`référence Git invalide : ${sha}`);
    const safe = this.safePath(cwd, path);
    const { stdout } = await runGit(cwd, [
      "show", "--no-ext-diff", "--diff-merges=first-parent", "--root", "-M", "--format=", sha, "--", safe,
    ]);
    return { diff: stdout };
  }

  async search(projectId: string, source: string | null, query: string): Promise<CodeSearchResult> {
    const cwd = await this.sourcePath(projectId, source);
    const needle = query.trim();
    if (needle.length < 2 || needle.length > 200 || needle.includes("\0")) {
      throw new CodeExplorerError("recherche entre 2 et 200 caractères");
    }
    const output = await runGit(cwd, [
      "grep", "-n", "-I", "-z", "--untracked", "-i", "-F", "--max-count=20", "-e", needle, "--",
    ], { accept: [0, 1], truncate: true, maxBytes: SEARCH_OUTPUT_BYTES });
    const lines = output.stdout.split("\n");
    if (output.truncated) lines.pop();
    const matches: CodeSearchMatch[] = [];
    for (const line of lines) {
      const pathEnd = line.indexOf("\0");
      if (pathEnd === -1) continue;
      const lineEnd = line.indexOf("\0", pathEnd + 1);
      if (lineEnd === -1) continue;
      const number = Number(line.slice(pathEnd + 1, lineEnd));
      if (!Number.isInteger(number)) continue;
      matches.push({ path: line.slice(0, pathEnd), line: number, text: line.slice(lineEnd + 1, lineEnd + 301) });
      if (matches.length > SEARCH_LIMIT) break;
    }
    return {
      query: needle,
      matches: matches.slice(0, SEARCH_LIMIT),
      truncated: output.truncated || matches.length > SEARCH_LIMIT,
    };
  }

  private async loadSources(projectId: string): Promise<CodeSource[]> {
    const projectPath = resolve(this.projectPath(projectId));
    const holders = new Map<string, CodeConversationLink[]>();
    const rows = this.db.query(`
      SELECT id, title, provider, worktree_path FROM conversations
      WHERE project_id = ? AND deleted_at IS NULL
      ORDER BY updated_at DESC
    `).all(projectId) as Array<{ id: string; title: string; provider: string; worktree_path: string | null }>;
    for (const row of rows) {
      const key = resolve(row.worktree_path ?? projectPath);
      const list = holders.get(key) ?? [];
      if (list.length < SOURCE_CONVERSATION_LIMIT) list.push({ id: row.id, title: row.title, provider: row.provider });
      holders.set(key, list);
    }

    const sources: CodeSource[] = [];
    const seen = new Set<string>();
    for (const repositoryPath of this.discoverRepositories(projectPath)) {
      const listing = await optionalGit(repositoryPath, ["worktree", "list", "--porcelain"]);
      if (listing === null) continue;
      const repositoryLabel = repositoryPath === projectPath
        ? basename(projectPath)
        : relative(projectPath, repositoryPath);
      for (const block of listing.trim().split(/\n\n+/)) {
        const fields = new Map<string, string>();
        for (const line of block.split("\n")) {
          const separator = line.indexOf(" ");
          fields.set(separator === -1 ? line : line.slice(0, separator), separator === -1 ? "" : line.slice(separator + 1));
        }
        const rawPath = fields.get("worktree");
        if (!rawPath || fields.has("bare") || fields.has("prunable")) continue;
        const path = resolve(rawPath);
        if (seen.has(path) || !existsSync(path)) continue;
        seen.add(path);
        sources.push({
          path,
          repositoryPath,
          repositoryLabel,
          branch: fields.get("branch")?.replace(/^refs\/heads\//, "") ?? null,
          head: fields.get("HEAD") ?? null,
          detached: fields.has("detached"),
          main: path === repositoryPath,
          conversations: holders.get(path) ?? [],
        });
      }
    }
    return sources;
  }

  /**
   * Dépôts du projet : la racine si elle est versionnée, puis les dépôts
   * imbriqués (un dossier `.git`, jamais un fichier `.git` de worktree, déjà
   * listé par son dépôt d'origine).
   */
  private discoverRepositories(projectPath: string): string[] {
    const found: string[] = [];
    const visit = (directory: string, depth: number) => {
      let entries;
      try {
        entries = readdirSync(directory, { withFileTypes: true });
      } catch {
        return;
      }
      const isRepository = entries.some((entry) => entry.name === ".git" && entry.isDirectory());
      if (isRepository) found.push(directory);
      if ((isRepository && directory !== projectPath) || depth >= DISCOVERY_DEPTH) return;
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || SKIPPED_DIRECTORIES.has(entry.name)) continue;
        visit(join(directory, entry.name), depth + 1);
      }
    };
    visit(projectPath, 0);
    const hasRoot = found[0] === projectPath;
    const nested = found.slice(hasRoot ? 1 : 0).sort((left, right) => left.localeCompare(right));
    return hasRoot ? [projectPath, ...nested] : nested;
  }

  private async sourcePath(projectId: string, requested: string | null): Promise<string> {
    const sources = await this.sources(projectId);
    if (!requested) {
      const fallback = sources[0];
      if (!fallback) throw new CodeExplorerError("aucun dépôt Git dans ce projet");
      return fallback.path;
    }
    const wanted = resolve(requested);
    const match = sources.find((source) => source.path === wanted);
    if (!match) throw new CodeExplorerError("état du code inconnu pour ce projet");
    return match.path;
  }

  private projectPath(projectId: string): string {
    const project = this.projects.get(projectId);
    if (!project) throw new CodeExplorerError("projet inconnu");
    return project.path;
  }

  private safePath(cwd: string, path: string): string {
    const normalized = path.trim();
    const absolute = resolve(cwd, normalized);
    const rel = relative(resolve(cwd), absolute);
    if (!normalized || rel === "" || rel.startsWith("..") || rel.includes("\0") || resolve(cwd, rel) !== absolute) {
      throw new CodeExplorerError(`chemin de fichier invalide : ${path}`);
    }
    return rel;
  }

  private withLinks(
    projectId: string,
    commits: Omit<CodeCommitSummary, "conversations">[],
  ): CodeCommitSummary[] {
    const links = this.links(projectId);
    return commits.map((commit) => ({ ...commit, conversations: links.get(commit.sha) ?? [] }));
  }

  private links(projectId: string): Map<string, CodeConversationLink[]> {
    const rows = this.db.query(`
      SELECT links.commit_sha, conversations.id, conversations.title, conversations.provider
      FROM commit_links links
      JOIN conversations ON conversations.id = links.conversation_id
      WHERE links.project_id = ?
    `).all(projectId) as Array<{ commit_sha: string; id: string; title: string; provider: string }>;
    const links = new Map<string, CodeConversationLink[]>();
    for (const row of rows) {
      const list = links.get(row.commit_sha) ?? [];
      list.push({ id: row.id, title: row.title, provider: row.provider });
      links.set(row.commit_sha, list);
    }
    return links;
  }
}
