import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REQUEST_TIMEOUT_MS = 15_000;
const HOSTS_INDENT = 0;
const HOST_INDENT = 2;
const HOST_PROPERTY_INDENT = 4;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class GitLabHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "GitLabHttpError";
  }
}

export class GitLabAuthError extends GitLabHttpError {
  constructor(status = 401, message = "GitLab authentication failed") {
    super(status, message);
    this.name = "GitLabAuthError";
  }
}

export interface GitLabUser {
  id: number;
  username: string;
}

export interface GitLabMergeRequest {
  iid: number;
  title: string;
  sourceBranch: string;
  targetBranch: string;
  state: string;
  url: string;
  updatedAt: string;
  draft: boolean;
  hasConflicts: boolean;
  mergeStatus: string;
  labels: string[];
  author: string;
  reviewers: string[];
}

export interface GitLabPipeline {
  id: number;
  status: string;
  url: string;
  updatedAt: string;
  ref: string;
  sha: string;
}

export interface GitLabEnvironment {
  id: number;
  name: string;
}

export interface GitLabDeployment {
  ref: string;
  mergeRequestIid: number | null;
  sha: string;
  status: string;
  createdAt: string;
  user: string;
  job: string | null;
  jobUrl: string | null;
}

function toStringValue(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function toNumberValue(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function hostNameOf(input: string): string | null {
  try {
    return new URL(input).hostname;
  } catch {
    return null;
  }
}

function indentationOf(line: string): number {
  return line.length - line.trimStart().length;
}

export function readGlabToken(host: string, home = homedir()): string | null {
  const hostname = hostNameOf(host);
  if (!hostname) return null;

  let content: string;
  try {
    content = readFileSync(join(home, ".config/glab-cli/config.yml"), "utf8");
  } catch {
    return null;
  }

  let insideHosts = false;
  let currentHost: string | null = null;
  for (const line of content.split(/\r?\n/u)) {
    if (line.trim() === "") continue;

    const indentation = indentationOf(line);
    const trimmed = line.trim();

    if (indentation === HOSTS_INDENT && trimmed === "hosts:") {
      insideHosts = true;
      currentHost = null;
      continue;
    }
    if (!insideHosts) continue;

    if (indentation === HOSTS_INDENT) {
      insideHosts = false;
      currentHost = null;
      continue;
    }

    const hostMatch = indentation === HOST_INDENT
      ? line.match(/^ {2}([^:\s]+):\s*$/u)
      : null;
    if (hostMatch) {
      currentHost = hostMatch[1] ?? null;
      continue;
    }

    const tokenMatch = indentation === HOST_PROPERTY_INDENT
      ? line.match(/^ {4}token:\s*(\S+)\s*$/u)
      : null;
    if (tokenMatch && currentHost === hostname) {
      return tokenMatch[1] ?? null;
    }
  }

  return null;
}

export function mergeRequestIidOfRef(ref: string): number | null {
  const match = ref.match(/^refs\/merge-requests\/(\d+)\/head$/u);
  if (!match) return null;
  const iid = Number(match[1]);
  return Number.isFinite(iid) ? iid : null;
}

export function parseMergeRequest(payload: unknown): GitLabMergeRequest {
  const typed = (payload ?? {}) as {
    iid?: unknown;
    title?: unknown;
    source_branch?: unknown;
    target_branch?: unknown;
    state?: unknown;
    web_url?: unknown;
    updated_at?: unknown;
    draft?: unknown;
    has_conflicts?: unknown;
    detailed_merge_status?: unknown;
    labels?: unknown;
    author?: { username?: unknown };
    reviewers?: Array<{ username?: unknown }>;
  };

  return {
    iid: toNumberValue(typed.iid),
    title: toStringValue(typed.title),
    sourceBranch: toStringValue(typed.source_branch),
    targetBranch: toStringValue(typed.target_branch),
    state: toStringValue(typed.state),
    url: toStringValue(typed.web_url),
    updatedAt: toStringValue(typed.updated_at),
    draft: Boolean(typed.draft),
    hasConflicts: Boolean(typed.has_conflicts),
    mergeStatus: toStringValue(typed.detailed_merge_status),
    labels: Array.isArray(typed.labels) ? typed.labels.map((label) => String(label)) : [],
    author: toStringValue(typed.author?.username),
    reviewers: Array.isArray(typed.reviewers) ? typed.reviewers.map((reviewer) => toStringValue(reviewer?.username)) : [],
  };
}

export function parseDeployment(payload: unknown): GitLabDeployment {
  const typed = (payload ?? {}) as {
    ref?: unknown;
    sha?: unknown;
    status?: unknown;
    created_at?: unknown;
    user?: { username?: unknown };
    deployable?: { name?: unknown; web_url?: unknown };
  };
  const ref = toStringValue(typed.ref);

  return {
    ref,
    mergeRequestIid: mergeRequestIidOfRef(ref),
    sha: toStringValue(typed.sha),
    status: toStringValue(typed.status),
    createdAt: toStringValue(typed.created_at),
    user: toStringValue(typed.user?.username),
    job: typed.deployable?.name === undefined || typed.deployable?.name === null ? null : String(typed.deployable.name),
    jobUrl: typed.deployable?.web_url === undefined || typed.deployable?.web_url === null ? null : String(typed.deployable.web_url),
  };
}

export class GitLabClient {
  private readonly baseUrl: string;

  constructor(
    private readonly auth: { host: string; token: string },
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.baseUrl = `${auth.host.replace(/\/+$/u, "")}/api/v4`;
  }

  async me(): Promise<GitLabUser> {
    const payload = await this.request<{ id?: unknown; username?: unknown }>("/user");
    return {
      id: toNumberValue(payload.id),
      username: toStringValue(payload.username),
    };
  }

  async projectId(path: string): Promise<number> {
    const payload = await this.request<{ id?: unknown }>(`/projects/${encodeURIComponent(path)}`);
    return toNumberValue(payload.id);
  }

  async openMergeRequests(projectId: number): Promise<GitLabMergeRequest[]> {
    const payload = await this.request<unknown[]>(`/projects/${projectId}/merge_requests?state=opened&scope=all&per_page=50`);
    return Array.isArray(payload) ? payload.map(parseMergeRequest) : [];
  }

  async mergeRequest(projectId: number, iid: number): Promise<GitLabMergeRequest> {
    const payload = await this.request(`/projects/${projectId}/merge_requests/${iid}`);
    return parseMergeRequest(payload);
  }

  async latestPipeline(projectId: number, iid: number): Promise<GitLabPipeline | null> {
    const payload = await this.request<unknown[]>(`/projects/${projectId}/merge_requests/${iid}/pipelines?per_page=1`);
    if (!Array.isArray(payload) || payload.length === 0) return null;

    const first = payload[0] as {
      id?: unknown;
      status?: unknown;
      web_url?: unknown;
      updated_at?: unknown;
      ref?: unknown;
      sha?: unknown;
    };

    return {
      id: toNumberValue(first.id),
      status: toStringValue(first.status),
      url: toStringValue(first.web_url),
      updatedAt: toStringValue(first.updated_at),
      ref: toStringValue(first.ref),
      sha: toStringValue(first.sha),
    };
  }

  async environmentByName(projectId: number, name: string): Promise<GitLabEnvironment | null> {
    const payload = await this.request<unknown[]>(
      `/projects/${projectId}/environments?search=${encodeURIComponent(name)}&states=available&per_page=50`,
    );
    if (!Array.isArray(payload)) return null;

    for (const environment of payload) {
      const typed = environment as { id?: unknown; name?: unknown };
      if (typed.name === name) {
        return { id: toNumberValue(typed.id), name };
      }
    }

    return null;
  }

  async lastDeployment(projectId: number, environmentId: number): Promise<GitLabDeployment | null> {
    const payload = await this.request<{ last_deployment?: unknown }>(`/projects/${projectId}/environments/${environmentId}`);
    if (payload.last_deployment === undefined || payload.last_deployment === null) return null;
    return parseDeployment(payload.last_deployment);
  }

  private async request<T>(path: string): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: {
        "PRIVATE-TOKEN": this.auth.token,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (response.status === 401 || response.status === 403) {
      throw new GitLabAuthError(response.status, `GitLab authentication failed (${response.status})`);
    }
    if (!response.ok) {
      throw new GitLabHttpError(response.status, `GitLab request failed: ${response.status}`);
    }

    return response.json() as Promise<T>;
  }
}
