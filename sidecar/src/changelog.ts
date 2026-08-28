import { existsSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { DebriefGenerator } from "./debriefs";
import type { DomainStore } from "./stores/domains";
import type { ProjectStore } from "./stores/projects";
import {
  ChangelogStore,
  type GitChangelogCommit,
  type ProjectChangelogPayload,
  type ProjectChangelogState,
} from "./stores/changelog";

export const CHANGELOG_BATCH_SIZE = 10;
export const CHANGELOG_BACKFILL_CONCURRENCY = 8;
export const CHANGELOG_BACKFILL_VERSION = 2;
export const CHANGELOG_ENRICHMENT_ATTEMPTS = 3;
export const CHANGELOG_REFRESH_INTERVAL_MS = 2 * 60 * 60_000;
export const CHANGELOG_SINCE = "2026-01-01T00:00:00Z";

export interface GitRepository {
  path: string;
  relativePath: string;
}

export interface GitHistoryOptions {
  repositoryPath: string;
  since?: string;
  limit?: number;
  authorEmails?: string[];
}

type GitHistoryReader = (cwd: string, options: GitHistoryOptions) => Promise<GitChangelogCommit[]>;
type GitRepositoryFinder = (cwd: string) => Promise<GitRepository[]>;
type GitEmailReader = (cwd: string) => Promise<string | null>;

export class ChangelogService {
  private active = new Set<string>();
  private activeEnrichments = 0;
  private enrichmentWaiters: Array<() => void> = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private commitListeners = new Set<(projectId: string, commits: GitChangelogCommit[]) => void>();

  constructor(
    private store: ChangelogStore,
    private projects: ProjectStore,
    private domains: DomainStore,
    private generator: DebriefGenerator,
    private history: GitHistoryReader = readGitHistory,
    private now: () => Date = () => new Date(),
    private repositories: GitRepositoryFinder = discoverGitRepositories,
    private email: GitEmailReader = readGitEmail,
  ) {}

  subscribeCommits(listener: (projectId: string, commits: GitChangelogCommit[]) => void): () => void {
    this.commitListeners.add(listener);
    return () => this.commitListeners.delete(listener);
  }

  start(): void {
    if (this.timer !== null) return;
    setTimeout(() => this.triggerDueProjects(), 250).unref?.();
    this.timer = setInterval(() => this.triggerDueProjects(), 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  list(projectId: string, domainId?: string): ProjectChangelogPayload {
    this.requireProject(projectId);
    return { entries: this.store.list(projectId, domainId), state: this.store.state(projectId) };
  }

  status(projectId: string): ProjectChangelogState {
    this.requireProject(projectId);
    return this.store.state(projectId);
  }

  trigger(projectId: string): ProjectChangelogState {
    const project = this.requireProject(projectId);
    if (this.active.has(projectId)) return this.store.state(projectId);
    this.active.add(projectId);
    this.store.markRunning(projectId, this.now().toISOString());
    void this.refresh(project.id, project.path).finally(() => this.active.delete(projectId));
    return this.store.state(projectId);
  }

  async refreshNow(projectId: string): Promise<ProjectChangelogPayload> {
    const project = this.requireProject(projectId);
    if (this.active.has(projectId)) return this.list(projectId);
    this.active.add(projectId);
    this.store.markRunning(projectId, this.now().toISOString());
    try {
      await this.refresh(project.id, project.path);
      return this.list(projectId);
    } finally {
      this.active.delete(projectId);
    }
  }

  private triggerDueProjects(): void {
    const now = this.now().getTime();
    for (const project of this.projects.list()) {
      if (!existsSync(project.path) || this.active.has(project.id)) continue;
      const next = this.store.state(project.id).next_refresh_at;
      if (next === null || Date.parse(next) <= now) this.trigger(project.id);
    }
  }

  private async refresh(projectId: string, path: string): Promise<void> {
    try {
      const state = this.store.state(projectId);
      const backfill = state.backfill_version < CHANGELOG_BACKFILL_VERSION;
      const repositories = await this.repositories(path);
      if (repositories.length === 0) throw new Error("aucun dépôt Git trouvé");
      const authorEmails = repositories.length > 1
        ? [...new Set((await Promise.all(repositories.map((repository) => this.email(repository.path))))
          .filter((value): value is string => Boolean(value)))]
        : [];
      if (repositories.length > 1 && authorEmails.length === 0) {
        throw new Error("identité Git introuvable pour le projet multi-dépôt");
      }
      const commits = (await Promise.all(repositories.map((repository) => this.history(
        repository.path,
        {
          repositoryPath: repository.relativePath,
          since: backfill ? CHANGELOG_SINCE : undefined,
          limit: backfill ? undefined : CHANGELOG_BATCH_SIZE,
          authorEmails,
        },
      )))).flat();
      if (backfill) this.store.reconcile(projectId, commits);
      this.store.import(projectId, commits, this.now().toISOString());
      for (const listener of this.commitListeners) listener(projectId, commits);
      await this.enrichPending(projectId, path, backfill);
      const refreshedAt = this.now();
      this.store.markFinished(
        projectId,
        refreshedAt.toISOString(),
        new Date(refreshedAt.getTime() + CHANGELOG_REFRESH_INTERVAL_MS).toISOString(),
        backfill ? CHANGELOG_BACKFILL_VERSION : undefined,
      );
    } catch (error) {
      const failedAt = this.now();
      this.store.markError(
        projectId,
        error instanceof Error ? error.message : "actualisation du changelog impossible",
        new Date(failedAt.getTime() + CHANGELOG_REFRESH_INTERVAL_MS).toISOString(),
      );
    }
  }

  private async enrichPending(projectId: string, path: string, backfill: boolean): Promise<void> {
    const pending = this.store.pending(
      projectId,
      backfill ? Number.MAX_SAFE_INTEGER : CHANGELOG_BATCH_SIZE,
    );
    if (pending.length === 0) return;
    const activeDomains = this.domains.listByProject(projectId)
      .filter((domain) => domain.status === "actif");
    const batches = Array.from(
      { length: Math.ceil(pending.length / CHANGELOG_BATCH_SIZE) },
      (_, index) => pending.slice(index * CHANGELOG_BATCH_SIZE, (index + 1) * CHANGELOG_BATCH_SIZE),
    );
    const failures: unknown[] = [];
    let nextBatch = 0;
    const worker = async () => {
      while (nextBatch < batches.length) {
        const batch = batches[nextBatch++]!;
        for (let attempt = 1; attempt <= CHANGELOG_ENRICHMENT_ATTEMPTS; attempt += 1) {
          try {
            const raw = await this.generateWithSlot({
              cwd: path,
              provider: "codex",
              model: "gpt-5.6-luna",
              effort: "medium",
              speed: "standard",
              prompt: enrichmentPrompt(batch, activeDomains),
            });
            const enriched = parseEnrichments(
              raw,
              batch.map((entry) => ({
                repositoryPath: entry.repository_path,
                sha: entry.commit_sha,
              })),
              activeDomains.map((domain) => domain.id),
            );
            this.store.enrich(projectId, enriched, this.now().toISOString());
            break;
          } catch (error) {
            if (attempt === CHANGELOG_ENRICHMENT_ATTEMPTS) failures.push(error);
          }
        }
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(backfill ? CHANGELOG_BACKFILL_CONCURRENCY : 1, batches.length) },
      worker,
    ));
    if (failures.length > 0) {
      const first = failures[0];
      throw first instanceof Error ? first : new Error("enrichissement du changelog impossible");
    }
  }

  private async generateWithSlot(input: Parameters<DebriefGenerator>[0]): Promise<string> {
    if (this.activeEnrichments < CHANGELOG_BACKFILL_CONCURRENCY) {
      this.activeEnrichments += 1;
    } else {
      await new Promise<void>((resolve) => this.enrichmentWaiters.push(resolve));
    }
    try {
      return await this.generator(input);
    } finally {
      const next = this.enrichmentWaiters.shift();
      if (next) next();
      else this.activeEnrichments -= 1;
    }
  }

  private requireProject(projectId: string) {
    const project = this.projects.get(projectId);
    if (!project) throw new Error("projet inconnu");
    return project;
  }
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr.trim() || "lecture de l'historique Git impossible");
  return stdout;
}

export async function discoverGitRepositories(root: string): Promise<GitRepository[]> {
  if (!existsSync(join(root, ".git"))) return [];
  const repositories: GitRepository[] = [];
  const ignored = new Set([
    ".git", ".cache", ".next", "build", "coverage", "dist", "node_modules", "target",
  ]);
  const visit = (directory: string) => {
    if (existsSync(join(directory, ".git"))) {
      const relativePath = relative(root, directory).split(sep).join("/") || ".";
      repositories.push({ path: directory, relativePath });
    }
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || ignored.has(entry.name)) continue;
      visit(join(directory, entry.name));
    }
  };
  visit(resolve(root));
  return repositories.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export async function readGitEmail(cwd: string): Promise<string | null> {
  try {
    const value = (await runGit(cwd, ["config", "--get", "user.email"])).trim().toLowerCase();
    return value || null;
  } catch {
    return null;
  }
}

function escapeExtendedRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

export async function readGitHistory(
  cwd: string,
  options: GitHistoryOptions,
): Promise<GitChangelogCommit[]> {
  const args = [
    "log", "-z", "--branches", "--remotes", "--source", "--topo-order",
    "--date=iso-strict", "--format=%H%x00%S%x00%cI%x00%s%x00%B",
  ];
  if (options.since) args.push(`--since=${options.since}`);
  if (options.limit !== undefined) args.push(`--max-count=${options.limit}`);
  if (options.authorEmails && options.authorEmails.length > 0) {
    const emailPattern = options.authorEmails.map(escapeExtendedRegex).join("|");
    args.push("--extended-regexp", "--regexp-ignore-case", `--author=<(${emailPattern})>`);
  }
  const raw = await runGit(cwd, args);
  const fields = raw.split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 5 !== 0) throw new Error("historique Git illisible");
  const commits: GitChangelogCommit[] = [];
  for (let index = 0; index < fields.length; index += 5) {
    const sha = fields[index]!.trim();
    const source = fields[index + 1]!.trim();
    const committedAt = fields[index + 2]!.trim();
    const subject = fields[index + 3]!.trim();
    const message = fields[index + 4]!.trim();
    if (!sha || !committedAt) continue;
    commits.push({
      repositoryPath: options.repositoryPath,
      sha,
      branch: source
        .replace(/^refs\/heads\//, "")
        .replace(/^refs\/remotes\//, "") || "HEAD",
      subject: subject || "Commit sans message",
      message: message || subject || "Commit sans message",
      committedAt,
    });
  }
  return commits;
}

function enrichmentPrompt(
  entries: Array<{
    repository_path: string;
    commit_sha: string;
    branch: string;
    subject: string;
    committed_at: string;
  }>,
  domains: Array<{ id: string; name: string; kind: string }>,
): string {
  return [
    "Tu enrichis un changelog produit à partir de commits Git déjà réalisés.",
    "Pour chaque commit fourni, écris une seule phrase concise en français qui décrit le résultat produit ou technique durable.",
    "Choisis au plus un domaine existant. Utilise null si aucun domaine ne convient. N'invente pas de domaine.",
    "Retourne uniquement un tableau JSON avec exactement un objet par commit, dans le même ordre.",
    '{"domainId":"..."|null,"productMessage":"..."}',
    `DOMAINES: ${JSON.stringify(domains)}`,
    `COMMITS: ${JSON.stringify(entries.map((entry) => ({
      sha: entry.commit_sha,
      repositoryPath: entry.repository_path,
      branch: entry.branch,
      subject: entry.subject,
      committedAt: entry.committed_at,
    })))}`,
  ].join("\n\n");
}

export function parseEnrichments(
  raw: string,
  expected: Array<{ repositoryPath: string; sha: string }>,
  allowedDomainIds: string[],
): Array<{
  repositoryPath: string;
  sha: string;
  domainId: string | null;
  productMessage: string;
}> {
  const match = raw.trim().match(/\[[\s\S]*\]/);
  if (!match) throw new Error("enrichissement du changelog invalide");
  const parsed = JSON.parse(match[0]) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== expected.length) {
    throw new Error("lot de changelog incomplet");
  }
  const domains = new Set(allowedDomainIds);
  return parsed.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("entrée de changelog invalide");
    }
    const item = value as Record<string, unknown>;
    const domainId = item.domainId === null ? null : String(item.domainId ?? "").trim();
    const productMessage = String(item.productMessage ?? "").trim();
    if (!productMessage) {
      throw new Error("entrée de changelog incohérente");
    }
    return {
      repositoryPath: expected[index]!.repositoryPath,
      sha: expected[index]!.sha,
      domainId: domainId !== null && domains.has(domainId) ? domainId : null,
      productMessage: productMessage.slice(0, 280),
    };
  });
}
