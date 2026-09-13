import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { discoverRepositories, ticketKeyOf } from "./git-repositories";
import type { ProjectStore } from "./stores/projects";

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TREE_PATHS = 60_000;
const MAX_COMMIT_FILES = 500;
const GRAPH_PAGE_SIZE = 300;
const HISTORY_LIMIT = 100;
const SEARCH_LIMIT = 300;
const SEARCH_OUTPUT_BYTES = 512 * 1024;
const SOURCE_CACHE_MS = 5_000;
const GIT_TIMEOUT_MS = 20_000;
const SOURCE_CONVERSATION_LIMIT = 25;
const BACKFILL_GRACE_MS = 2 * 60_000;
const BASE_BRANCHES = ["origin/develop", "origin/main", "origin/master", "develop", "main", "master"];
const FULL_SHA = /^[0-9a-f]{40,64}$/i;
const SHORT_SHA = /^[0-9a-f]{7,64}$/i;
const UNCOMMITTED = /^0+$/;
const SUBJECT_TICKET = /\b([A-Za-z]{2,10})-(\d{3,})\b/;
const TRAILERS = "%(trailers:key=Co-Authored-By,valueonly,separator=%x1f)";
const LOG_FORMAT = `--format=%H%x00%P%x00%D%x00%an%x00%aI%x00%s%x00${TRAILERS}`;
const AGENT_PATTERNS: Array<[CodeAgent["provider"], RegExp]> = [
  ["claude", /claude|anthropic/i],
  ["codex", /codex|openai|chatgpt/i],
  ["grok", /grok|x\.ai/i],
];

export class CodeExplorerError extends Error {}

export interface CodeConversationLink {
  id: string;
  title: string;
  provider: string;
}

/** Agent déclaré co-auteur par un trailer `Co-Authored-By` du message de commit. */
export interface CodeAgent {
  provider: "claude" | "codex" | "grok";
  name: string;
}

export interface CodeSource {
  /** Chemin du worktree, ou `<dépôt>#<référence>` pour une branche sans worktree. */
  path: string;
  repositoryPath: string;
  repositoryLabel: string;
  branch: string | null;
  head: string | null;
  detached: boolean;
  main: boolean;
  conversations: CodeConversationLink[];
  /** Référence lue en lecture seule quand aucun worktree ne porte la branche. */
  ref: string | null;
  updatedAt: string | null;
}

export type CodeDirtyStatus = "M" | "A" | "D" | "R" | "?";

export interface CodeFileList {
  paths: string[];
  /** Dépôts imbriqués (sous-modules ou clones non suivis) : des dossiers, jamais des fichiers lisibles. */
  submodules: string[];
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
  agent: CodeAgent | null;
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
  agent: CodeAgent | null;
}

export interface CodeGraphPage {
  head: string | null;
  currentBranch: string | null;
  base: string | null;
  focus: string[];
  /** Commits propres à la branche (base..HEAD), même quand ils sortent de la page chargée. */
  focusCommits: CodeCommitSummary[];
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

interface ResolvedSource {
  source: CodeSource;
  cwd: string;
  /** Commit de la branche lue en lecture seule ; nul pour un worktree. */
  sha: string | null;
}

interface GitOutput {
  stdout: string;
  truncated: boolean;
}

interface GitOptions {
  accept?: number[];
  maxBytes?: number;
  truncate?: boolean;
  stdin?: string;
}

export interface CodeConversationRepository {
  repositoryPath: string;
  repositoryLabel: string;
  commits: CodeCommitSummary[];
}

export interface CodeTicketConversation {
  id: string;
  title: string;
  commits: number;
}

export interface CodeTicketCommits {
  key: string;
  /** Commits portés par les branches du ticket, dépôt par dépôt, fusions et collègues compris. */
  branchCommits: number;
  total: number;
  repositories: CodeConversationRepository[];
  conversations: CodeTicketConversation[];
}

export interface CodeConversationCommits {
  conversationId: string;
  total: number;
  repositories: CodeConversationRepository[];
  /** Commits reliés aux conversations qui partagent la clé de ticket de celle-ci, elle comprise. */
  ticket: CodeTicketCommits | null;
}

export interface CodeBranchChanges {
  base: string | null;
  /** Point de départ du diff : la base, ou le premier parent de la fusion pour une branche intégrée. */
  from: string | null;
  head: string | null;
  files: CodeCommitFile[];
  filesTruncated: boolean;
}

function parseDiffFiles(numstat: string, nameStatus: string): CodeCommitFile[] {
  const stats = new Map<string, { added: number | null; removed: number | null }>();
  const numFields = numstat.split("\0");
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
  const statusFields = nameStatus.split("\0").filter((field) => field !== "");
  for (let index = 0; index < statusFields.length; index += 1) {
    const status = statusFields[index] ?? "";
    if (!/^[A-Z]\d*$/.test(status)) continue;
    const renamed = status.startsWith("R") || status.startsWith("C");
    const previousPath = renamed ? statusFields[index + 1] ?? null : null;
    const path = renamed ? statusFields[index + 2] ?? "" : statusFields[index + 1] ?? "";
    index += renamed ? 2 : 1;
    files.push({ path, previousPath, status: status[0]!, ...(stats.get(path) ?? { added: null, removed: null }) });
  }
  return files;
}

async function runGit(cwd: string, args: string[], options: GitOptions = {}): Promise<GitOutput> {
  const maxBytes = options.maxBytes ?? MAX_OUTPUT_BYTES;
  const child = Bun.spawn(["git", ...args], {
    cwd,
    ...(options.stdin !== undefined ? { stdin: Buffer.from(options.stdin) } : {}),
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

export function agentFromTrailers(trailers: string): CodeAgent | null {
  for (const value of trailers.split("\x1f")) {
    const name = value.replace(/\s*<[^>]*>\s*$/, "").trim();
    if (!name) continue;
    const match = AGENT_PATTERNS.find(([, pattern]) => pattern.test(value));
    if (match) return { provider: match[0], name };
  }
  return null;
}

function parseCommitRecords(output: string): Omit<CodeCommitSummary, "conversations">[] {
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const commits: Omit<CodeCommitSummary, "conversations">[] = [];
  for (let index = 0; index + 6 < fields.length; index += 7) {
    const [rawSha = "", rawParents = "", rawRefs = "", author = "", authoredAt = "", subject = "", trailers = ""] =
      fields.slice(index, index + 7);
    const sha = rawSha.replace(/^\n/, "");
    if (!FULL_SHA.test(sha)) throw new CodeExplorerError("sortie git log invalide");
    commits.push({
      sha,
      parents: rawParents.split(" ").filter(Boolean),
      refs: rawRefs.split(",").map((ref) => ref.trim()).filter(Boolean),
      author,
      authoredAt,
      subject,
      agent: agentFromTrailers(trailers),
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
  private backfills = new Map<string, Promise<number>>();

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
    const { cwd, sha } = await this.resolveSource(projectId, source);
    if (sha) {
      const listed = await runGit(cwd, ["ls-tree", "-r", "-z", "--full-tree", sha], { truncate: true });
      const entries = listed.stdout.split("\0");
      if (listed.truncated) entries.pop();
      const paths: string[] = [];
      const submodules: string[] = [];
      for (const entry of entries) {
        const tab = entry.indexOf("\t");
        if (tab === -1) continue;
        if (entry.startsWith("160000 ")) submodules.push(entry.slice(tab + 1));
        else paths.push(entry.slice(tab + 1));
      }
      return {
        paths: paths.slice(0, MAX_TREE_PATHS).sort((left, right) => left.localeCompare(right)),
        submodules: submodules.sort((left, right) => left.localeCompare(right)),
        dirty: [],
        truncated: listed.truncated || paths.length > MAX_TREE_PATHS,
      };
    }

    const [tracked, untracked, status] = await Promise.all([
      runGit(cwd, ["ls-files", "--stage", "-z"], { truncate: true }),
      runGit(cwd, ["ls-files", "-o", "--exclude-standard", "-z"], { truncate: true }),
      runGit(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { truncate: true }),
    ]);
    const submodules = new Set<string>();
    const rawPaths: string[] = [];
    const stageEntries = tracked.stdout.split("\0");
    if (tracked.truncated) stageEntries.pop();
    for (const entry of stageEntries) {
      const tab = entry.indexOf("\t");
      if (tab === -1) continue;
      const path = entry.slice(tab + 1);
      if (entry.startsWith("160000 ")) submodules.add(path);
      else rawPaths.push(path);
    }
    const untrackedEntries = untracked.stdout.split("\0");
    if (untracked.truncated) untrackedEntries.pop();
    for (const path of untrackedEntries) {
      if (!path) continue;
      if (path.endsWith("/")) submodules.add(path.slice(0, -1));
      else rawPaths.push(path);
    }
    const unique = [...new Set(rawPaths)];
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
      submodules: [...submodules].sort((left, right) => left.localeCompare(right)),
      dirty: dirty.filter((item) => !submodules.has(item.path.replace(/\/$/, ""))),
      truncated: tracked.truncated || untracked.truncated || unique.length > MAX_TREE_PATHS,
    };
  }

  async file(projectId: string, source: string | null, path: string, ref?: string | null): Promise<CodeFile> {
    const { cwd, sha } = await this.resolveSource(projectId, source);
    const safe = this.safePath(cwd, path);
    const wanted = ref?.trim() || sha || "worktree";
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
    const { cwd, sha: refSha } = await this.resolveSource(projectId, source);
    const safe = this.safePath(cwd, path);
    let output: string;
    try {
      output = (await runGit(cwd, ["blame", "--porcelain", ...(refSha ? [refSha] : []), "--", safe])).stdout;
    } catch (error) {
      const absolute = join(cwd, safe);
      if (refSha || !existsSync(absolute)) throw error;
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
          agent: null,
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
          groups.push({
            sha,
            start: finalLine,
            count: 1,
            author: "",
            authoredAt: null,
            summary: "",
            uncommitted: UNCOMMITTED.test(sha),
            conversations: [],
            agent: null,
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
    const committed = [...new Set(groups.filter((group) => !group.uncommitted).map((group) => group.sha))];
    const agents = new Map<string, CodeAgent | null>();
    if (committed.length > 0) {
      const trailers = await optionalGit(cwd, ["log", "--no-walk=unsorted", "-z", `--format=%H%x00${TRAILERS}`, ...committed]);
      const fields = (trailers ?? "").split("\0");
      for (let index = 0; index + 1 < fields.length; index += 2) {
        agents.set(fields[index]!.replace(/^\n/, ""), agentFromTrailers(fields[index + 1] ?? ""));
      }
    }
    for (const group of groups) {
      group.conversations = links.get(group.sha) ?? [];
      group.agent = agents.get(group.sha) ?? null;
    }
    return { path: safe, lineCount, groups };
  }

  async history(projectId: string, source: string | null, path: string): Promise<CodeCommitSummary[]> {
    const { cwd, sha } = await this.resolveSource(projectId, source);
    const safe = this.safePath(cwd, path);
    const { stdout } = await runGit(cwd, [
      "log", "-z", "--follow", `--max-count=${HISTORY_LIMIT}`, LOG_FORMAT, ...(sha ? [sha] : []), "--", safe,
    ]);
    return this.withLinks(projectId, parseCommitRecords(stdout));
  }

  async graph(projectId: string, source: string | null, skip = 0): Promise<CodeGraphPage> {
    const { cwd, sha: refSha, source: resolved } = await this.resolveSource(projectId, source);
    const offset = Number.isInteger(skip) && skip > 0 ? skip : 0;
    const [log, headOutput, branchOutput] = await Promise.all([
      runGit(cwd, [
        "log", "-z", "--topo-order", "--exclude=refs/stash", "--all",
        `--skip=${offset}`, `--max-count=${GRAPH_PAGE_SIZE + 1}`, LOG_FORMAT,
      ], { accept: [0, 128] }),
      refSha ? Promise.resolve(refSha) : optionalGit(cwd, ["rev-parse", "--verify", "-q", "HEAD"]),
      refSha ? Promise.resolve(resolved.branch) : optionalGit(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]),
    ]);
    const records = parseCommitRecords(log.stdout);
    const head = headOutput?.trim() || null;
    const currentBranch = branchOutput?.trim() || null;
    let base: string | null = null;
    let focusCommits: CodeCommitSummary[] = [];
    if (offset === 0 && head) {
      base = await this.findBase(cwd, currentBranch);
      const from = base ? await this.branchStart(cwd, head, base, resolved.main) : null;
      const own = from ? await optionalGit(cwd, ["log", "-z", "--topo-order", "--max-count=500", LOG_FORMAT, `${from}..${head}`]) : null;
      focusCommits = own ? this.withLinks(projectId, parseCommitRecords(own)) : [];
    }
    return {
      head,
      currentBranch,
      base,
      focus: focusCommits.map((commit) => commit.sha),
      focusCommits,
      commits: this.withLinks(projectId, records.slice(0, GRAPH_PAGE_SIZE)),
      skip: offset,
      hasMore: records.length > GRAPH_PAGE_SIZE,
    };
  }

  async commit(projectId: string, source: string | null, sha: string): Promise<CodeCommitDetail> {
    const { cwd } = await this.resolveSource(projectId, source);
    if (!SHORT_SHA.test(sha)) throw new CodeExplorerError(`référence Git invalide : ${sha}`);
    const { stdout } = await runGit(cwd, [
      "show", "-s", "-z", `--format=%H%x00%P%x00%D%x00%an%x00%ae%x00%aI%x00%s%x00${TRAILERS}%x00%b`, sha,
    ]);
    const [full = "", rawParents = "", rawRefs = "", author = "", email = "", authoredAt = "", subject = "", trailers = "", body = ""] =
      stdout.split("\0");
    if (!FULL_SHA.test(full)) throw new CodeExplorerError(`commit introuvable : ${sha}`);
    const parents = rawParents.split(" ").filter(Boolean);
    const range = parents.length > 0 ? [parents[0]!, full] : ["--root", full];
    const [numstat, nameStatus] = await Promise.all([
      runGit(cwd, ["diff-tree", "-r", "-M", "-z", "--no-commit-id", "--numstat", ...range]),
      runGit(cwd, ["diff-tree", "-r", "-M", "-z", "--no-commit-id", "--name-status", ...range]),
    ]);
    const files = parseDiffFiles(numstat.stdout, nameStatus.stdout);

    const [summary] = this.withLinks(projectId, [{
      sha: full,
      parents,
      refs: rawRefs.split(",").map((ref) => ref.trim()).filter(Boolean),
      author,
      authoredAt,
      subject,
      agent: agentFromTrailers(trailers),
    }]);
    return {
      ...summary!,
      email,
      body: body.trim(),
      files: files.slice(0, MAX_COMMIT_FILES),
      filesTruncated: files.length > MAX_COMMIT_FILES,
    };
  }

  /** Fichiers modifiés par la branche de cet état du code, tous commits confondus. */
  async changes(projectId: string, source: string | null): Promise<CodeBranchChanges> {
    const resolved = await this.resolveSource(projectId, source);
    const { base, from, head } = await this.branchRange(resolved);
    if (!from || !head) return { base, from: null, head, files: [], filesTruncated: false };
    const range = `${from}...${head}`;
    const [numstat, nameStatus] = await Promise.all([
      runGit(resolved.cwd, ["diff", "--no-ext-diff", "-M", "-z", "--numstat", range]),
      runGit(resolved.cwd, ["diff", "--no-ext-diff", "-M", "-z", "--name-status", range]),
    ]);
    const files = parseDiffFiles(numstat.stdout, nameStatus.stdout);
    return { base, from, head, files: files.slice(0, MAX_COMMIT_FILES), filesTruncated: files.length > MAX_COMMIT_FILES };
  }

  /** Commits reliés à une conversation, regroupés par dépôt du projet, et ceux de son ticket. */
  async conversationCommits(projectId: string, conversationId: string): Promise<CodeConversationCommits> {
    await this.backfillCommitLinks(projectId);
    const conversations = this.db.query(`
      SELECT id, title, worktree_path, created_on_branch FROM conversations
      WHERE project_id = ? AND deleted_at IS NULL
      ORDER BY updated_at DESC
    `).all(projectId) as Array<{ id: string; title: string; worktree_path: string | null; created_on_branch: string | null }>;
    const current = conversations.find((row) => row.id === conversationId);
    const key = current ? ticketKeyOf(current.created_on_branch, current.worktree_path) : null;
    const members = key
      ? conversations.filter((row) => row.id === conversationId || ticketKeyOf(row.created_on_branch, row.worktree_path) === key)
      : [{ id: conversationId, title: "" }];
    const links = this.db.query(`
      SELECT commit_sha, conversation_id FROM commit_links
      WHERE project_id = ? AND conversation_id IN (SELECT value FROM json_each(?))
    `).all(projectId, JSON.stringify(members.map((row) => row.id))) as Array<{ commit_sha: string; conversation_id: string }>;

    const ticketRepositories = await this.commitsByRepository(projectId, links.map((link) => link.commit_sha));
    const own = new Set(links.filter((link) => link.conversation_id === conversationId).map((link) => link.commit_sha));
    const repositories = ticketRepositories
      .map((repository) => ({ ...repository, commits: repository.commits.filter((entry) => own.has(entry.sha)) }))
      .filter((repository) => repository.commits.length > 0);
    const found = new Set(ticketRepositories.flatMap((repository) => repository.commits.map((entry) => entry.sha)));
    const counts = new Map<string, number>();
    for (const link of links) {
      if (found.has(link.commit_sha)) counts.set(link.conversation_id, (counts.get(link.conversation_id) ?? 0) + 1);
    }
    return {
      conversationId,
      total: repositories.reduce((total, repository) => total + repository.commits.length, 0),
      repositories,
      ticket: key
        ? {
          key,
          branchCommits: await this.ticketBranchCommits(projectId, key),
          total: found.size,
          repositories: ticketRepositories,
          conversations: members
            .filter((row) => counts.has(row.id))
            .map((row) => ({ id: row.id, title: row.title, commits: counts.get(row.id)! })),
        }
        : null,
    };
  }

  private async commitsByRepository(projectId: string, shas: string[]): Promise<CodeConversationRepository[]> {
    const projectPath = resolve(this.projectPath(projectId));
    const remaining = new Set(shas);
    const repositories: CodeConversationRepository[] = [];
    for (const repository of discoverRepositories(projectPath)) {
      if (remaining.size === 0) break;
      const check = await runGit(repository, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], {
        stdin: `${[...remaining].join("\n")}\n`,
      }).catch(() => null);
      const found = (check?.stdout ?? "").split("\n")
        .map((line) => line.split(" "))
        .filter(([sha, type]) => type === "commit" && sha && remaining.has(sha))
        .map(([sha]) => sha!);
      if (found.length === 0) continue;
      for (const sha of found) remaining.delete(sha);
      const log = await runGit(repository, ["log", "--no-walk=sorted", "-z", LOG_FORMAT, "--stdin"], { stdin: `${found.join("\n")}\n` });
      repositories.push({
        repositoryPath: repository,
        repositoryLabel: repository === projectPath ? basename(projectPath) : relative(projectPath, repository),
        commits: this.withLinks(projectId, parseCommitRecords(log.stdout)),
      });
    }
    return repositories;
  }

  async diff(projectId: string, source: string | null, sha: string, path: string, range: string | null = null): Promise<{ diff: string }> {
    const resolved = await this.resolveSource(projectId, source);
    const { cwd, sha: refSha } = resolved;
    const safe = this.safePath(cwd, path);
    if (range === "branch") {
      const { from, head } = await this.branchRange(resolved);
      if (!from || !head) return { diff: "" };
      const { stdout } = await runGit(cwd, ["diff", "--no-ext-diff", "-M", `${from}...${head}`, "--", safe]);
      return { diff: stdout };
    }
    if (!sha) {
      if (refSha) return { diff: "" };
      const tracked = await optionalGit(cwd, ["diff", "--no-ext-diff", "-M", "HEAD", "--", safe]);
      if (tracked) return { diff: tracked };
      const untracked = await optionalGit(cwd, ["ls-files", "--others", "--exclude-standard", "--", safe]);
      if (!untracked?.trim()) return { diff: "" };
      const added = await runGit(cwd, ["diff", "--no-index", "--no-ext-diff", "--", "/dev/null", safe], { accept: [0, 1] });
      return { diff: added.stdout };
    }
    if (!SHORT_SHA.test(sha)) throw new CodeExplorerError(`référence Git invalide : ${sha}`);
    const { stdout } = await runGit(cwd, [
      "show", "--no-ext-diff", "--diff-merges=first-parent", "--root", "-M", "--format=", sha, "--", safe,
    ]);
    return { diff: stdout };
  }

  async search(projectId: string, source: string | null, query: string): Promise<CodeSearchResult> {
    const { cwd, sha } = await this.resolveSource(projectId, source);
    const needle = query.trim();
    if (needle.length < 2 || needle.length > 200 || needle.includes("\0")) {
      throw new CodeExplorerError("recherche entre 2 et 200 caractères");
    }
    const output = await runGit(cwd, [
      "grep", "-n", "-I", "-z", ...(sha ? [] : ["--untracked"]), "-i", "-F", "--max-count=20", "-e", needle,
      ...(sha ? [sha] : []), "--",
    ], { accept: [0, 1], truncate: true, maxBytes: SEARCH_OUTPUT_BYTES });
    const lines = output.stdout.split("\n");
    if (output.truncated) lines.pop();
    const treePrefix = sha ? `${sha}:` : "";
    const matches: CodeSearchMatch[] = [];
    for (const line of lines) {
      const pathEnd = line.indexOf("\0");
      if (pathEnd === -1) continue;
      const lineEnd = line.indexOf("\0", pathEnd + 1);
      if (lineEnd === -1) continue;
      const number = Number(line.slice(pathEnd + 1, lineEnd));
      if (!Number.isInteger(number)) continue;
      const rawPath = line.slice(0, pathEnd);
      matches.push({
        path: treePrefix && rawPath.startsWith(treePrefix) ? rawPath.slice(treePrefix.length) : rawPath,
        line: number,
        text: line.slice(lineEnd + 1, lineEnd + 301),
      });
      if (matches.length > SEARCH_LIMIT) break;
    }
    return {
      query: needle,
      matches: matches.slice(0, SEARCH_LIMIT),
      truncated: output.truncated || matches.length > SEARCH_LIMIT,
    };
  }

  /**
   * Rattrape la provenance des commits faits avant que le suivi des tours ne
   * couvre les dépôts imbriqués : un commit signé de l'utilisateur, daté dans
   * la fenêtre d'un seul tour, revient à sa conversation. Plusieurs tours
   * simultanés se départagent par la clé de ticket du sujet du commit.
   */
  backfillCommitLinks(projectId: string): Promise<number> {
    const running = this.backfills.get(projectId);
    if (running) return running;
    const task = this.runBackfill(projectId).catch(() => 0);
    this.backfills.set(projectId, task);
    return task;
  }

  private async runBackfill(projectId: string): Promise<number> {
    const projectPath = resolve(this.projectPath(projectId));
    const turns = this.db.query(`
      SELECT e.conversation_id AS conversationId,
        json_extract(e.payload, '$.startedAt') AS startedAt,
        json_extract(e.payload, '$.completedAt') AS completedAt
      FROM events e
      JOIN conversations c ON c.id = e.conversation_id
      WHERE c.project_id = ? AND c.deleted_at IS NULL
        AND json_extract(e.payload, '$.type') = 'turn-timing'
        AND json_extract(e.payload, '$.phase') = 'completed'
    `).all(projectId) as Array<{ conversationId: string; startedAt: string | null; completedAt: string | null }>;
    const windows = turns
      .map((turn) => ({
        conversationId: turn.conversationId,
        start: Date.parse(turn.startedAt ?? ""),
        end: Date.parse(turn.completedAt ?? "") + BACKFILL_GRACE_MS,
      }))
      .filter((window) => Number.isFinite(window.start) && Number.isFinite(window.end));
    if (windows.length === 0) return 0;

    const conversationKeys = new Map((this.db.query(`
      SELECT id, worktree_path, created_on_branch FROM conversations WHERE project_id = ?
    `).all(projectId) as Array<{ id: string; worktree_path: string | null; created_on_branch: string | null }>)
      .map((row) => [row.id, ticketKeyOf(row.created_on_branch, row.worktree_path)]));
    const linked = new Set((this.db.query("SELECT commit_sha FROM commit_links WHERE project_id = ?")
      .all(projectId) as Array<{ commit_sha: string }>).map((row) => row.commit_sha));
    const insert = this.db.query(`
      INSERT OR IGNORE INTO commit_links (commit_sha, project_id, conversation_id, created_at)
      VALUES (?, ?, ?, ?)
    `);
    const since = new Date(Math.min(...windows.map((window) => window.start))).toISOString();
    const now = new Date().toISOString();
    let count = 0;
    for (const repository of discoverRepositories(projectPath)) {
      const email = (await optionalGit(repository, ["config", "--get", "user.email"]))?.trim().toLowerCase();
      if (!email) continue;
      const output = await optionalGit(repository, [
        "log", "--all", "--no-merges", "-z", `--since=${since}`, "--format=%H%x00%ce%x00%cI%x00%s",
      ]);
      const fields = (output ?? "").split("\0");
      for (let index = 0; index + 3 < fields.length; index += 4) {
        const sha = fields[index]!.replace(/^\n/, "");
        const time = Date.parse(fields[index + 2]!);
        if (!FULL_SHA.test(sha) || linked.has(sha) || fields[index + 1]!.toLowerCase() !== email || !Number.isFinite(time)) continue;
        const candidates = [...new Set(windows.filter((window) => time >= window.start && time <= window.end).map((window) => window.conversationId))];
        let owner = candidates.length === 1 ? candidates[0] : undefined;
        if (!owner && candidates.length > 1) {
          const subjectKey = fields[index + 3]!.match(SUBJECT_TICKET);
          const key = subjectKey ? `${subjectKey[1]!.toUpperCase()}-${subjectKey[2]}` : null;
          const matching = key ? candidates.filter((id) => conversationKeys.get(id) === key) : [];
          if (matching.length === 1) owner = matching[0];
        }
        if (!owner) continue;
        insert.run(sha, projectId, owner, now);
        linked.add(sha);
        count += 1;
      }
    }
    return count;
  }

  private async findBase(cwd: string, currentBranch: string | null): Promise<string | null> {
    for (const candidate of BASE_BRANCHES) {
      if (candidate === currentBranch) continue;
      if (await optionalGit(cwd, ["rev-parse", "--verify", "-q", `${candidate}^{commit}`])) return candidate;
    }
    return null;
  }

  /**
   * Début de la branche : la base tant qu'elle a des commits d'avance ; pour
   * une branche déjà fusionnée, le premier parent de la fusion qui l'a
   * intégrée, retrouvée sur la lignée principale de la base.
   */
  private async branchStart(cwd: string, head: string, base: string, main: boolean): Promise<string | null> {
    const ahead = Number((await optionalGit(cwd, ["rev-list", "--count", `${base}..${head}`]))?.trim() ?? 0);
    if (ahead > 0) return base;
    if (main) return null;
    const merges = (await optionalGit(cwd, ["rev-list", "--ancestry-path", "--merges", "--reverse", `${head}..${base}`])) ?? "";
    if (!merges.trim()) return null;
    const mainline = new Set(((await optionalGit(cwd, ["rev-list", "--first-parent", "--max-count=5000", base])) ?? "").split("\n"));
    const merge = merges.split("\n").find((sha) => sha && mainline.has(sha));
    return merge ? `${merge}^1` : null;
  }

  private async branchRange({ cwd, sha, source }: ResolvedSource): Promise<{ base: string | null; from: string | null; head: string | null }> {
    const head = sha ?? ((await optionalGit(cwd, ["rev-parse", "--verify", "-q", "HEAD"]))?.trim() || null);
    const branch = sha ? source.branch : ((await optionalGit(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]))?.trim() || null);
    if (!head) return { base: null, from: null, head: null };
    const base = await this.findBase(cwd, branch);
    return { base, from: base ? await this.branchStart(cwd, head, base, source.main) : null, head };
  }

  private async loadSources(projectId: string): Promise<CodeSource[]> {
    const projectPath = resolve(this.projectPath(projectId));
    await this.backfillCommitLinks(projectId);
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
    for (const repositoryPath of discoverRepositories(projectPath)) {
      const listing = await optionalGit(repositoryPath, ["worktree", "list", "--porcelain"]);
      if (listing === null) continue;
      const repositoryLabel = repositoryPath === projectPath
        ? basename(projectPath)
        : relative(projectPath, repositoryPath);
      const checkedOut = new Set<string>();
      for (const block of listing.trim().split(/\n\n+/)) {
        const fields = new Map<string, string>();
        for (const line of block.split("\n")) {
          const separator = line.indexOf(" ");
          fields.set(separator === -1 ? line : line.slice(0, separator), separator === -1 ? "" : line.slice(separator + 1));
        }
        const rawPath = fields.get("worktree");
        const branch = fields.get("branch")?.replace(/^refs\/heads\//, "") ?? null;
        if (branch) checkedOut.add(branch);
        if (!rawPath || fields.has("bare") || fields.has("prunable")) continue;
        const path = resolve(rawPath);
        if (seen.has(path) || !existsSync(path)) continue;
        seen.add(path);
        sources.push({
          path,
          repositoryPath,
          repositoryLabel,
          branch,
          head: fields.get("HEAD") ?? null,
          detached: fields.has("detached"),
          main: path === repositoryPath,
          conversations: holders.get(path) ?? [],
          ref: null,
          updatedAt: null,
        });
      }
      sources.push(...await this.branchSources(repositoryPath, repositoryLabel, checkedOut));
    }
    return sources;
  }

  /** Branches à clé de ticket qu'aucun worktree ne porte : locales de préférence, sinon distantes. */
  private async branchSources(repositoryPath: string, repositoryLabel: string, checkedOut: Set<string>): Promise<CodeSource[]> {
    const output = await optionalGit(repositoryPath, [
      "for-each-ref", "--format=%(refname)%00%(objectname)%00%(committerdate:iso-strict)", "refs/heads", "refs/remotes",
    ]);
    const byName = new Map<string, { local: boolean; source: CodeSource }>();
    for (const line of (output ?? "").split("\n")) {
      const [full = "", sha = "", date = ""] = line.split("\0");
      let name: string;
      let ref: string;
      let local: boolean;
      if (full.startsWith("refs/heads/")) {
        name = full.slice("refs/heads/".length);
        ref = name;
        local = true;
      } else if (full.startsWith("refs/remotes/")) {
        ref = full.slice("refs/remotes/".length);
        const slash = ref.indexOf("/");
        if (slash === -1 || ref.endsWith("/HEAD")) continue;
        name = ref.slice(slash + 1);
        local = false;
      } else {
        continue;
      }
      if (checkedOut.has(name) || !ticketKeyOf(name)) continue;
      const existing = byName.get(name);
      if (existing && (existing.local || !local)) continue;
      byName.set(name, {
        local,
        source: {
          path: `${repositoryPath}#${ref}`,
          repositoryPath,
          repositoryLabel,
          branch: name,
          head: sha || null,
          detached: false,
          main: false,
          conversations: [],
          ref,
          updatedAt: date || null,
        },
      });
    }
    return [...byName.values()]
      .map((entry) => entry.source)
      .sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""));
  }

  /** Même choix que l'état « chantier » de l'onglet Code : une source par dépôt, le worktree avant la branche. */
  private async ticketBranchCommits(projectId: string, key: string): Promise<number> {
    const rank = (source: CodeSource) => source.ref === null
      ? (/-before$/i.test(source.path) ? 2 : source.branch === null ? 1 : 0)
      : (source.ref === source.branch ? 3 : 4);
    const chosen = new Map<string, CodeSource>();
    for (const source of await this.sources(projectId)) {
      if (source.main || ticketKeyOf(source.branch, source.path) !== key) continue;
      const current = chosen.get(source.repositoryPath);
      if (!current || rank(source) < rank(current)) chosen.set(source.repositoryPath, source);
    }
    const counts = await Promise.all([...chosen.values()].map(async (source) => {
      const resolved = await this.resolveMatch(source).catch(() => null);
      if (!resolved) return 0;
      const { from, head } = await this.branchRange(resolved);
      if (!from || !head) return 0;
      return Number((await optionalGit(resolved.cwd, ["rev-list", "--count", `${from}..${head}`]))?.trim()) || 0;
    }));
    return counts.reduce((total, count) => total + count, 0);
  }

  private async resolveSource(projectId: string, requested: string | null): Promise<ResolvedSource> {
    const sources = await this.sources(projectId);
    const match = !requested
      ? sources[0]
      : requested.includes("#")
        ? sources.find((source) => source.path === requested)
        : sources.find((source) => source.path === resolve(requested));
    if (!match) {
      throw new CodeExplorerError(requested ? "état du code inconnu pour ce projet" : "aucun dépôt Git dans ce projet");
    }
    return this.resolveMatch(match);
  }

  private async resolveMatch(match: CodeSource): Promise<ResolvedSource> {
    if (!match.ref) return { source: match, cwd: match.path, sha: null };
    const sha = (await optionalGit(match.repositoryPath, ["rev-parse", "--verify", "-q", "--end-of-options", `${match.ref}^{commit}`]))?.trim();
    if (!sha) throw new CodeExplorerError(`branche introuvable : ${match.branch}`);
    return { source: match, cwd: match.repositoryPath, sha };
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
