import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compileBranchPattern, extractTicketKey } from "../ticket-key";
import { ClickUpAuthError, type ClickUpTask } from "./clickup";
import { GitLabAuthError, type GitLabMergeRequest } from "./gitlab";
import type { ConversationStore } from "../stores/conversations";
import type { IntegrationStore, ProjectIntegration } from "../stores/integrations";
import type { ProjectStore } from "../stores/projects";
import type { TicketStore } from "../stores/tickets";
import type { SentryIssue, SentryStore } from "../stores/sentry";
import { SentryAuthError, type SentryIssueSummary } from "./sentry";
import { classifySentryIssue, compileDomainCatalog, type DomainDefinition } from "../sentry-domains";

export const INTEGRATIONS_POLL_MS = 5 * 60 * 1000;
export const INTEGRATIONS_IDLE_POLL_MS = 30 * 60 * 1000;
export const SENTRY_POLL_MS = 15 * 60 * 1000;
export const SENTRY_IDLE_POLL_MS = 60 * 60 * 1000;

export interface ClickUpConfig {
  teamId: string;
  listIds: string[];
}

export interface GitLabProjectConfig {
  path: string;
  label: string;
  environments: string[];
}

export interface GitLabConfig {
  host: string;
  projects: GitLabProjectConfig[];
}

export interface EnvironmentState {
  project: string;
  name: string;
  missing?: boolean;
  branch: string | null;
  key: string | null;
  mergeRequestIid: number | null;
  user: string | null;
  deployedAt: string | null;
  status: string | null;
  jobUrl: string | null;
}

export interface RefresherStores {
  integrations: IntegrationStore;
  tickets: TicketStore;
  conversations: ConversationStore;
  projects: ProjectStore;
  sentry?: SentryStore;
}
export interface SentryHandle {
  listIssues(input: {
    org: string;
    project: string;
    environment: "production";
    statsPeriod: string;
    query: string;
  }): Promise<SentryIssueSummary[]>;
  issueDetail(org: string, id: string): Promise<unknown>;
  issueEvents?(org: string, id: string, input: { environment: "production"; statsPeriod: string }): Promise<unknown>;
}

type ClickUpContext = { description: string; comments: Array<{ author: string; text: string; at: string }> };

export interface ClickUpHandle {
  me(): Promise<number>;
  assignedTasks(input: { teamId: string; listIds: string[]; userId: number }): Promise<ClickUpTask[]>;
  taskContext(taskId: string): Promise<ClickUpContext>;
  createTask?(input: { listId: string; name: string; description: string }): Promise<ClickUpTask>;
}

export interface GitLabHandle {
  me(): Promise<{ id: number; username: string }>;
  projectId(path: string): Promise<number>;
  openMergeRequests(projectId: number): Promise<GitLabMergeRequest[]>;
  mergeRequest(projectId: number, iid: number): Promise<GitLabMergeRequest>;
  latestPipeline(projectId: number, iid: number): Promise<{
    id: number;
    status: string;
    url: string;
    updatedAt: string;
    ref: string;
    sha: string;
  } | null>;
  environmentByName(projectId: number, name: string): Promise<{ id: number; name: string } | null>;
  lastDeployment(projectId: number, environmentId: number): Promise<{
    ref: string;
    mergeRequestIid: number | null;
    sha: string;
    status: string;
    createdAt: string;
    user: string;
    job: string | null;
    jobUrl: string | null;
  } | null>;
}

export interface RefresherDeps {
  clickUpClient?: (integration: ProjectIntegration) => ClickUpHandle | null;
  gitLabClient?: (integration: ProjectIntegration) => GitLabHandle | null;
  sentryClient?: (integration: ProjectIntegration) => SentryHandle | null;
  branchOfWorktree?: (path: string) => string | null;
}

type Listener = (projectId: string) => void;

export class IntegrationsRefresher {
  private readonly listeners = new Set<Listener>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly queuedRefreshes = new Map<string, Promise<void>>();
  private readonly mergeRequestCache = new Map<string, GitLabMergeRequest>();
  private readonly lastSentryRefresh = new Map<string, number>();
  private readonly forcedSentryRefresh = new Set<string>();
  private active = true;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly stores: RefresherStores,
    private readonly deps: RefresherDeps = {},
  ) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  start(intervalMs = INTEGRATIONS_POLL_MS): void {
    if (this.timer !== null) return;
    void this.refreshAll();
    this.timer = setInterval(() => {
      void this.refreshAll();
    }, intervalMs);
    this.timer.unref?.();
  }

  setInterval(intervalMs: number): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      void this.refreshAll();
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async refreshAll(): Promise<void> {
    const projectIds = new Set(this.stores.integrations.listAll().map((integration) => integration.project_id));
    for (const project of this.stores.projects.list()) {
      projectIds.add(project.id);
    }
    await Promise.all(
      [...projectIds].map((projectId) =>
        this.refreshProject(projectId).catch(() => {}),
      ),
    );
  }

  setActive(active: boolean): void {
    this.active = active;
  }

  refreshProject(projectId: string, options: { forceSentry?: boolean } = {}): Promise<void> {
    if (options.forceSentry) this.forcedSentryRefresh.add(projectId);
    const queued = this.queuedRefreshes.get(projectId);
    if (queued) return queued;

    const running = this.inFlight.get(projectId);
    if (running) {
      const rerun = running.then(
        () => this.startProjectRefresh(projectId),
        () => this.startProjectRefresh(projectId),
      ).finally(() => {
        this.queuedRefreshes.delete(projectId);
      });
      this.queuedRefreshes.set(projectId, rerun);
      return rerun;
    }
    return this.startProjectRefresh(projectId);
  }

  private startProjectRefresh(projectId: string): Promise<void> {
    const run = this.run(projectId).finally(() => {
      this.inFlight.delete(projectId);
    });
    this.inFlight.set(projectId, run);
    return run;
  }

  async clickUpContext(
    projectId: string,
    ticketKey: string,
  ): Promise<{ description: string; comments: Array<{ author: string; text: string; at: string }> } | null> {
    const integration = this.stores.integrations.find(projectId, "clickup");
    if (!integration) return null;
    const client = this.clickUp(integration);
    const ticket = this.stores.tickets.findByKey(projectId, ticketKey);
    const clickUpId = ticket?.payload.clickupId;
    if (!client || typeof clickUpId !== "string") return null;
    try {
      return await client.taskContext(clickUpId);
    } catch {
      return null;
    }
  }

  async createClickUpTask(
    projectId: string,
    input: { name: string; description: string },
  ): Promise<ClickUpTask> {
    const integration = this.stores.integrations.find(projectId, "clickup");
    if (!integration) throw new Error("ClickUp n'est pas configuré pour ce projet");
    const client = this.clickUp(integration);
    if (!client?.createTask) throw new Error("Création ClickUp indisponible");
    const config = integration.config as unknown as ClickUpConfig & { creationListId?: string };
    const listId = config.creationListId || config.listIds?.[0];
    if (!listId) throw new Error("Aucune liste ClickUp de création configurée");
    const task = await client.createTask({ listId, ...input });
    this.upsertClickUpTask(projectId, task);
    return task;
  }

  async sentryIssueContext(issue: SentryIssue): Promise<{ detail: unknown; events: unknown }> {
    const integration = this.stores.integrations.listByProject(issue.project_id)
      .find((item) => item.id === issue.integration_id && item.type === "sentry");
    if (!integration) throw new Error("Intégration Sentry inconnue");
    const client = this.deps.sentryClient?.(integration) ?? null;
    const config = integration.config as { org?: string };
    if (!client || !config.org) throw new Error("Sentry n'est pas configuré");
    const [detail, events] = await Promise.all([
      client.issueDetail(config.org, issue.sentry_issue_id),
      client.issueEvents?.(config.org, issue.sentry_issue_id, {
        environment: "production",
        statsPeriod: "24h",
      }) ?? Promise.resolve([]),
    ]);
    return { detail, events };
  }

  private async run(projectId: string): Promise<void> {
    const forceSentry = this.forcedSentryRefresh.delete(projectId);
    const items = this.stores.integrations.listByProject(projectId);
    const pattern = compiledPattern(items);
    const mergedKeys = new Set<string>();
    for (const item of orderIntegrations(items)) {
      for (const key of await this.refreshOne(item, pattern, forceSentry)) mergedKeys.add(key);
    }
    this.refreshGitSource(projectId, pattern);
    this.stores.tickets.archiveKeys(projectId, mergedKeys);
    this.stores.tickets.archiveStale(projectId);
    for (const listener of this.listeners) {
      listener(projectId);
    }
  }

  private async refreshOne(
    item: ProjectIntegration,
    pattern: RegExp | null,
    forceSentry: boolean,
  ): Promise<Set<string>> {
    try {
      if (item.type === "clickup") {
        await this.refreshClickUp(item);
      } else if (item.type === "gitlab") {
        return await this.refreshGitLab(item, pattern);
      } else if (item.type === "sentry") {
        const cadence = this.active ? SENTRY_POLL_MS : SENTRY_IDLE_POLL_MS;
        const lastRefresh = this.lastSentryRefresh.get(item.id) ?? 0;
        if (!forceSentry && Date.now() - lastRefresh < cadence) return new Set<string>();
        await this.refreshSentry(item);
        this.lastSentryRefresh.set(item.id, Date.now());
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isAuth = error instanceof ClickUpAuthError || error instanceof GitLabAuthError || error instanceof SentryAuthError;
      this.stores.integrations.markError(item.id, isAuth ? "à reconfigurer" : "dégradée", message);
    }
    return new Set<string>();
  }

  private clickUp(item: ProjectIntegration): ClickUpHandle | null {
    return this.deps.clickUpClient?.(item) ?? null;
  }

  private async refreshSentry(item: ProjectIntegration): Promise<void> {
    const client = this.deps.sentryClient?.(item) ?? null;
    const store = this.stores.sentry;
    if (!client || !store) {
      this.stores.integrations.markUnconfigured(item.id);
      return;
    }
    const config = item.config as {
      org?: string;
      projects?: string[];
      domains?: DomainDefinition[];
    };
    if (!config.org || !Array.isArray(config.projects) || config.projects.length === 0) {
      this.stores.integrations.markUnconfigured(item.id);
      return;
    }
    const catalog = compileDomainCatalog(
      config.domains ?? [],
      this.stores.tickets.listActive(item.project_id),
    );
    const scannedAt = new Date().toISOString();
    const seen = new Set<string>();
    let count = 0;
    for (const project of config.projects) {
      const issues = await client.listIssues({
        org: config.org,
        project,
        environment: "production",
        statsPeriod: "24h",
        query: "is:unresolved",
      });
      for (const issue of issues) {
        seen.add(issue.id);
        count++;
        store.upsertIssue({
          integrationId: item.id,
          projectId: item.project_id,
          sentryIssueId: issue.id,
          payload: { ...issue },
          relevance: classifySentryIssue(issue, [], catalog),
          scannedAt,
        });
      }
    }
    const resolved = new Set<string>();
    for (const issue of store.listProject(item.project_id)) {
      if (issue.integration_id !== item.id || seen.has(issue.sentry_issue_id)) continue;
      const detail = await client.issueDetail(config.org, issue.sentry_issue_id);
      if (isResolvedSentryIssue(detail)) resolved.add(issue.sentry_issue_id);
    }
    store.markMissing(item.id, seen, resolved, scannedAt);
    store.sweep();
    this.stores.integrations.markOk(item.id, { issues: count, projects: config.projects.length });
  }

  private async refreshClickUp(item: ProjectIntegration): Promise<void> {
    const client = this.clickUp(item);
    if (!client) {
      this.stores.integrations.markUnconfigured(item.id);
      return;
    }
    const config = item.config as unknown as ClickUpConfig;
    const userId = await client.me();
    const tasks = await client.assignedTasks({
      teamId: config.teamId,
      listIds: config.listIds ?? [],
      userId,
    });
    this.stores.tickets.transaction(() => {
      for (const task of tasks) {
        this.upsertClickUpTask(item.project_id, task);
      }
    });
    this.stores.integrations.markOk(item.id, { userId, tasks: tasks.length });
  }

  private upsertClickUpTask(projectId: string, task: ClickUpTask): void {
    this.stores.tickets.upsert(projectId, {
      key: task.key,
      source: "clickup",
      title: task.title,
      status: task.status,
      externalUrl: task.url,
      payload: {
        clickupId: task.id,
        statusColor: task.statusColor,
        list: task.list,
        priority: task.priority,
        labels: task.labels,
        updatedAt: task.updatedAt,
      },
    });
  }

  private gitLab(item: ProjectIntegration): GitLabHandle | null {
    return this.deps.gitLabClient?.(item) ?? null;
  }

  private async refreshGitLab(item: ProjectIntegration, pattern: RegExp | null): Promise<Set<string>> {
    const client = this.gitLab(item);
    if (!client) {
      this.stores.integrations.markUnconfigured(item.id);
      return new Set<string>();
    }
    const config = item.config as unknown as GitLabConfig;
    const me = await client.me();
    const environments: EnvironmentState[] = [];
    const toReview: Array<GitLabMergeRequest & { project: string }> = [];
    const writes: Array<() => void> = [];
    const mergedKeys = new Set<string>();

    for (const projectConfig of config.projects ?? []) {
      const gitLabProjectId = await client.projectId(projectConfig.path);
      const mergeRequests = await client.openMergeRequests(gitLabProjectId);

      for (const mr of mergeRequests) {
        this.mergeRequestCache.set(`${gitLabProjectId}:${mr.iid}`, mr);
        const isMine = mr.author === me.username;
        const reviewsMine = mr.reviewers.includes(me.username) && !isMine;
        if (reviewsMine) {
          toReview.push({ ...mr, project: projectConfig.label });
        }

        const key = extractTicketKey(mr.sourceBranch, pattern);
        if (key === null) continue;
        const knownTicket = this.stores.tickets.findByKey(item.project_id, key);
        if (!isMine && !knownTicket) continue;

        const pipeline = isMine || knownTicket
          ? await client.latestPipeline(gitLabProjectId, mr.iid)
          : null;

        writes.push(() => {
          const ticket = this.stores.tickets.upsert(item.project_id, {
            key,
            source: "git",
            title: mr.title,
            status: "",
            externalUrl: null,
          });
          this.stores.tickets.upsertRef(ticket.id, {
            kind: "branch",
            ref: mr.sourceBranch,
            payload: { project: projectConfig.label },
          });
          this.stores.tickets.upsertRef(ticket.id, {
            kind: "mr",
            ref: `${projectConfig.label}!${mr.iid}`,
            payload: mergeRequestPayload(mr, projectConfig.label),
          });
          if (pipeline) {
            this.stores.tickets.upsertRef(ticket.id, {
              kind: "pipeline",
              ref: `${projectConfig.label}!${mr.iid}`,
              payload: { ...pipeline, project: projectConfig.label },
            });
          }
        });
      }

      for (const name of projectConfig.environments ?? []) {
        const environment = await client.environmentByName(gitLabProjectId, name);
        if (!environment) {
          environments.push({
            project: projectConfig.label,
            name,
            missing: true,
            branch: null,
            key: null,
            mergeRequestIid: null,
            user: null,
            deployedAt: null,
            status: null,
            jobUrl: null,
          });
          continue;
        }

        const deployment = await client.lastDeployment(gitLabProjectId, environment.id);
        let branch: string | null = deployment?.ref ?? null;
        let deploymentMergeRequest: GitLabMergeRequest | null = null;
        if (deployment?.mergeRequestIid) {
          const cacheKey = `${gitLabProjectId}:${deployment.mergeRequestIid}`;
          const mr = this.mergeRequestCache.get(cacheKey)
            ?? await client.mergeRequest(gitLabProjectId, deployment.mergeRequestIid);
          this.mergeRequestCache.set(cacheKey, mr);
          deploymentMergeRequest = mr;
          branch = mr.sourceBranch;
        }

        const key = branch ? extractTicketKey(branch, pattern) : null;
        const state: EnvironmentState = {
          project: projectConfig.label,
          name,
          branch,
          key,
          mergeRequestIid: deployment?.mergeRequestIid ?? null,
          user: deployment?.user ?? null,
          deployedAt: deployment?.createdAt ?? null,
          status: deployment?.status ?? null,
          jobUrl: deployment?.jobUrl ?? null,
        };
        environments.push(state);

        if (key !== null && branch !== null) {
          if (deploymentMergeRequest?.state === "merged") mergedKeys.add(key);
          writes.push(() => {
            const ticket = this.stores.tickets.upsert(item.project_id, {
              key,
              source: "git",
              title: deploymentMergeRequest?.title ?? branch,
              status: "",
              externalUrl: null,
            });
            this.stores.tickets.upsertRef(ticket.id, {
              kind: "branch",
              ref: branch,
              payload: { project: projectConfig.label },
            });
            this.stores.tickets.upsertRef(ticket.id, {
              kind: "deployment",
              ref: `${projectConfig.label}:${name}`,
              payload: {
                environment: name,
                project: projectConfig.label,
                user: state.user,
                deployedAt: state.deployedAt,
                status: state.status,
                jobUrl: state.jobUrl,
              },
            });
            if (deploymentMergeRequest) {
              this.stores.tickets.upsertRef(ticket.id, {
                kind: "mr",
                ref: `${projectConfig.label}!${deploymentMergeRequest.iid}`,
                payload: mergeRequestPayload(deploymentMergeRequest, projectConfig.label),
              });
            }
          });
        }
      }
    }

    this.stores.tickets.transaction(() => {
      for (const write of writes) {
        write();
      }
    });
    this.stores.integrations.markOk(item.id, { username: me.username, environments, toReview });
    return mergedKeys;
  }

  private refreshGitSource(projectId: string, pattern: RegExp | null): void {
    const branchOfWorktree = this.deps.branchOfWorktree ?? defaultBranchOfWorktree;
    this.stores.tickets.transaction(() => {
      for (const conversation of this.stores.conversations.listByProject(projectId)) {
        if (!conversation.worktree_path) continue;
        const branch = branchOfWorktree(conversation.worktree_path);
        if (!branch) continue;
        const key = extractTicketKey(branch, pattern);
        if (key === null) continue;
        const ticket = this.stores.tickets.upsert(projectId, {
          key,
          source: "git",
          title: branch,
          status: "",
          externalUrl: null,
        });
        this.stores.tickets.upsertRef(ticket.id, {
          kind: "branch",
          ref: branch,
          payload: { local: true },
        });
        if (conversation.ticket_id === null) {
          this.stores.tickets.linkConversation(conversation.id, ticket.id);
        }
      }
    });
  }
}

function compiledPattern(items: ProjectIntegration[]): RegExp | null {
  const pattern = items.find((item) => item.branch_pattern)?.branch_pattern ?? null;
  return pattern ? compileBranchPattern(pattern) : null;
}

function mergeRequestPayload(mr: GitLabMergeRequest, project: string): Record<string, unknown> {
  return {
    iid: mr.iid,
    project,
    title: mr.title,
    state: mr.state,
    url: mr.url,
    draft: mr.draft,
    hasConflicts: mr.hasConflicts,
    mergeStatus: mr.mergeStatus,
    labels: mr.labels,
    author: mr.author,
    reviewers: mr.reviewers,
    targetBranch: mr.targetBranch,
    updatedAt: mr.updatedAt,
  };
}

function orderIntegrations(items: ProjectIntegration[]): ProjectIntegration[] {
  const rank: Record<ProjectIntegration["type"], number> = {
    clickup: 0,
    gitlab: 1,
    github: 2,
    notion: 3,
    sentry: 4,
  };
  return [...items].sort((left, right) => rank[left.type] - rank[right.type]);
}

function isResolvedSentryIssue(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return (value as { status?: unknown }).status === "resolved";
}

function defaultBranchOfWorktree(path: string): string | null {
  try {
    const gitEntry = readFileSync(join(path, ".git"), "utf8");
    const gitDir = gitEntry.match(/^gitdir: (.+)$/mu)?.[1];
    if (!gitDir) return null;
    const head = readFileSync(join(gitDir, "HEAD"), "utf8");
    return head.match(/^ref: refs\/heads\/(.+)$/mu)?.[1] ?? null;
  } catch {
    return null;
  }
}
