import { existsSync } from "node:fs";
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
export const CHANGELOG_REFRESH_INTERVAL_MS = 2 * 60 * 60_000;
export const CHANGELOG_SINCE = "2026-01-01T00:00:00Z";

type GitHistoryReader = (cwd: string, since: string) => Promise<GitChangelogCommit[]>;

export class ChangelogService {
  private active = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private store: ChangelogStore,
    private projects: ProjectStore,
    private domains: DomainStore,
    private generator: DebriefGenerator,
    private history: GitHistoryReader = readGitHistory,
    private now: () => Date = () => new Date(),
  ) {}

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
      const commits = await this.history(path, CHANGELOG_SINCE);
      this.store.import(projectId, commits, this.now().toISOString());
      const pending = this.store.pending(projectId, CHANGELOG_BATCH_SIZE);
      if (pending.length > 0) {
        const activeDomains = this.domains.listByProject(projectId)
          .filter((domain) => domain.status === "actif");
        const raw = await this.generator({
          cwd: path,
          provider: "codex",
          model: "gpt-5.6-luna",
          effort: "medium",
          speed: "standard",
          prompt: enrichmentPrompt(pending, activeDomains),
        });
        const enriched = parseEnrichments(
          raw,
          pending.map((entry) => entry.commit_sha),
          activeDomains.map((domain) => domain.id),
        );
        this.store.enrich(projectId, enriched, this.now().toISOString());
      }
      const refreshedAt = this.now();
      this.store.markFinished(
        projectId,
        refreshedAt.toISOString(),
        new Date(refreshedAt.getTime() + CHANGELOG_REFRESH_INTERVAL_MS).toISOString(),
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

export async function readGitHistory(cwd: string, since: string): Promise<GitChangelogCommit[]> {
  const raw = await runGit(cwd, [
    "log", "-z", "--all", "--source", "--topo-order", `--since=${since}`,
    "--date=iso-strict", "--format=%H%x00%S%x00%cI%x00%s",
  ]);
  const fields = raw.split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 4 !== 0) throw new Error("historique Git illisible");
  const commits: GitChangelogCommit[] = [];
  for (let index = 0; index < fields.length; index += 4) {
    const sha = fields[index]!.trim();
    const source = fields[index + 1]!.trim();
    const committedAt = fields[index + 2]!.trim();
    const subject = fields[index + 3]!.trim();
    if (!sha || !committedAt) continue;
    commits.push({
      sha,
      branch: source
        .replace(/^refs\/heads\//, "")
        .replace(/^refs\/remotes\//, "") || "HEAD",
      subject: subject || "Commit sans message",
      committedAt,
    });
  }
  return commits;
}

function enrichmentPrompt(
  entries: Array<{ commit_sha: string; branch: string; subject: string; committed_at: string }>,
  domains: Array<{ id: string; name: string; kind: string }>,
): string {
  return [
    "Tu enrichis un changelog produit à partir de commits Git déjà réalisés.",
    "Pour chaque commit fourni, écris une seule phrase concise en français qui décrit le résultat produit ou technique durable.",
    "Choisis au plus un domaine existant. Utilise null si aucun domaine ne convient. N'invente pas de domaine.",
    "Retourne uniquement un tableau JSON avec exactement un objet par commit, dans le même ordre.",
    '{"sha":"...","domainId":"..."|null,"productMessage":"..."}',
    `DOMAINES: ${JSON.stringify(domains)}`,
    `COMMITS: ${JSON.stringify(entries.map((entry) => ({
      sha: entry.commit_sha,
      branch: entry.branch,
      subject: entry.subject,
      committedAt: entry.committed_at,
    })))}`,
  ].join("\n\n");
}

export function parseEnrichments(
  raw: string,
  expectedShas: string[],
  allowedDomainIds: string[],
): Array<{ sha: string; domainId: string | null; productMessage: string }> {
  const match = raw.trim().match(/\[[\s\S]*\]/);
  if (!match) throw new Error("enrichissement du changelog invalide");
  const parsed = JSON.parse(match[0]) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== expectedShas.length) {
    throw new Error("lot de changelog incomplet");
  }
  const domains = new Set(allowedDomainIds);
  return parsed.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("entrée de changelog invalide");
    }
    const item = value as Record<string, unknown>;
    const sha = String(item.sha ?? "").trim();
    const domainId = item.domainId === null ? null : String(item.domainId ?? "").trim();
    const productMessage = String(item.productMessage ?? "").trim();
    if (sha !== expectedShas[index] || (domainId !== null && !domains.has(domainId)) || !productMessage) {
      throw new Error("entrée de changelog incohérente");
    }
    return { sha, domainId, productMessage: productMessage.slice(0, 280) };
  });
}
