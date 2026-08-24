const BASE_URL = "https://api.clickup.com/api/v2";
const MAX_TASK_DESCRIPTION_CHARS = 2000;

export class ClickUpHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "ClickUpHttpError";
  }
}

export class ClickUpAuthError extends ClickUpHttpError {
  constructor(status = 401, message = "ClickUp authentication failed") {
    super(status, message);
    this.name = "ClickUpAuthError";
  }
}

export interface ClickUpTask {
  id: string;
  key: string;
  title: string;
  status: string;
  statusColor: string | null;
  url: string;
  updatedAt: string;
  list: string | null;
  priority: string | null;
  labels: string[];
}

export interface ClickUpTaskContext {
  description: string;
  comments: Array<{ author: string; text: string; at: string }>;
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function toIsoEpoch(value: unknown): string {
  const millis = Number(value);
  if (!Number.isFinite(millis) || millis <= 0) return new Date(0).toISOString();
  return new Date(millis).toISOString();
}

function toStringValue(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function parseLabels(customFields: unknown): string[] {
  if (!Array.isArray(customFields)) return [];

  const labels: string[] = [];
  for (const field of customFields) {
    if (!field || typeof field !== "object") continue;
    const typedField = field as {
      type?: unknown;
      value?: unknown;
      type_config?: { options?: Array<{ id?: unknown; label?: unknown }> };
    };
    if (typedField.type !== "labels" || !Array.isArray(typedField.value)) continue;

    const options = Array.isArray(typedField.type_config?.options) ? typedField.type_config?.options : [];
    for (const optionId of typedField.value) {
      const match = options.find((option) => option?.id === optionId);
      if (match?.label) labels.push(String(match.label));
    }
  }

  return labels;
}

export function parseClickUpTasks(payload: unknown): ClickUpTask[] {
  if (!payload || typeof payload !== "object") return [];

  const tasks = (payload as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasks)) return [];

  return tasks.map((task) => {
    const typedTask = task as {
      id?: unknown;
      custom_id?: unknown;
      name?: unknown;
      status?: { status?: unknown; color?: unknown };
      url?: unknown;
      date_updated?: unknown;
      list?: { name?: unknown };
      priority?: { priority?: unknown };
      custom_fields?: unknown;
    };

    return {
      id: toStringValue(typedTask.id),
      key: typedTask.custom_id ? toStringValue(typedTask.custom_id) : toStringValue(typedTask.id),
      title: toStringValue(typedTask.name),
      status: toStringValue(typedTask.status?.status),
      statusColor: typedTask.status?.color ? String(typedTask.status.color) : null,
      url: toStringValue(typedTask.url),
      updatedAt: toIsoEpoch(typedTask.date_updated),
      list: typedTask.list?.name ? String(typedTask.list.name) : null,
      priority: typedTask.priority?.priority ? String(typedTask.priority.priority) : null,
      labels: parseLabels(typedTask.custom_fields),
    };
  });
}

export class ClickUpClient {
  constructor(private readonly token: string, private readonly fetchImpl: FetchLike = fetch) {}

  async me(): Promise<number> {
    const payload = await this.request<{ user?: { id?: unknown } }>("/user");
    const id = payload.user?.id;
    if (typeof id !== "number") {
      throw new ClickUpHttpError(500, "Unexpected /user response");
    }
    return id;
  }

  async assignedTasks(input: { teamId: string; listIds: string[]; userId: number }): Promise<ClickUpTask[]> {
    const tasks: ClickUpTask[] = [];
    let page = 0;
    while (true) {
      const params = new URLSearchParams();
      params.set("include_closed", "false");
      params.set("subtasks", "true");
      params.set("page", String(page));
      params.append("assignees[]", String(input.userId));
      for (const listId of input.listIds) params.append("list_ids[]", listId);

      const payload = await this.request<{ tasks?: unknown; last_page?: unknown }>(
        `/team/${encodeURIComponent(input.teamId)}/task?${params.toString()}`,
      );
      tasks.push(...parseClickUpTasks(payload));

      if (payload.last_page !== false) break;
      page += 1;
    }
    return tasks;
  }

  async taskContext(taskId: string, maxComments = 8): Promise<ClickUpTaskContext> {
    const [task, comments] = await Promise.all([
      this.request<{ description?: unknown }>(`/task/${encodeURIComponent(taskId)}`),
      this.request<{ comments?: unknown }>(`/task/${encodeURIComponent(taskId)}/comment`),
    ]);

    const commentList = Array.isArray(comments.comments) ? comments.comments.slice(0, maxComments) : [];
    return {
      description: toStringValue(task.description).slice(0, MAX_TASK_DESCRIPTION_CHARS),
      comments: commentList.map((comment) => {
        const typedComment = comment as {
          user?: { username?: unknown };
          comment_text?: unknown;
          date?: unknown;
        };
        return {
          author: typedComment.user?.username ? String(typedComment.user.username) : "?",
          text: toStringValue(typedComment.comment_text),
          at: toIsoEpoch(typedComment.date),
        };
      }),
    };
  }

  async createTask(input: { listId: string; name: string; description: string }): Promise<ClickUpTask> {
    const payload = await this.request<unknown>(`/list/${encodeURIComponent(input.listId)}/task`, {
      method: "POST",
      body: JSON.stringify({ name: input.name, description: input.description }),
    });
    const [task] = parseClickUpTasks({ tasks: [payload] });
    if (!task?.id) throw new ClickUpHttpError(500, "Unexpected task creation response");
    return task;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(`${BASE_URL}${path}`, {
      ...init,
      headers: {
        Authorization: this.token,
        accept: "application/json",
        "content-type": "application/json",
        ...init.headers,
      },
    });

    if (response.status === 401 || response.status === 403) {
      throw new ClickUpAuthError(response.status);
    }
    if (!response.ok) {
      throw new ClickUpHttpError(response.status, `ClickUp request failed: ${response.status}`);
    }

    return response.json() as Promise<T>;
  }
}
