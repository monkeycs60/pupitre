import type { EnvironmentState } from "./integrations/refresher";
import type { GitLabMergeRequest } from "./integrations/gitlab";
import type { IntegrationStatus, IntegrationStore, IntegrationType } from "./stores/integrations";
import type { TicketRow, TicketStore } from "./stores/tickets";
import type { ProblemProjectPayload, ProblemStore } from "./stores/problems";

export interface DashboardPayload {
  projectId: string;
  refreshedAt: string;
  integrations: Array<{
    id: string;
    type: IntegrationType;
    status: IntegrationStatus;
    last_ok_at: string | null;
    last_error: string | null;
    branch_pattern: string | null;
    config: Record<string, unknown>;
  }>;
  tickets: TicketRow[];
  environments: EnvironmentState[];
  toReview: Array<GitLabMergeRequest & { project: string }>;
  problems: ProblemProjectPayload;
}

export function dashboardPayload(
  projectId: string,
  integrations: IntegrationStore,
  tickets: TicketStore,
  problems?: ProblemStore,
): DashboardPayload {
  const items = integrations.listByProject(projectId);
  const gitlab = items.find((item) => item.type === "gitlab");

  return {
    projectId,
    refreshedAt: new Date().toISOString(),
    integrations: items.map((item) => ({
      id: item.id,
      type: item.type,
      status: item.status,
      last_ok_at: item.last_ok_at,
      last_error: item.last_error,
      branch_pattern: item.branch_pattern,
      config: item.config,
    })),
    tickets: tickets.listByProject(projectId).filter((ticket) =>
      ticket.source === "clickup" && ticket.payload.assignedToMe !== false
    ),
    environments: Array.isArray(gitlab?.snapshot.environments)
      ? gitlab.snapshot.environments as EnvironmentState[]
      : [],
    toReview: Array.isArray(gitlab?.snapshot.toReview)
      ? gitlab.snapshot.toReview as Array<GitLabMergeRequest & { project: string }>
      : [],
    problems: problems?.listProject(projectId, "all") ?? {
      projectId,
      captures: [],
      problems: [],
    },
  };
}
