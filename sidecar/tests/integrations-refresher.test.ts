import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { ClickUpAuthError, type ClickUpTask } from "../src/integrations/clickup";
import { IntegrationsRefresher } from "../src/integrations/refresher";
import type { GitLabMergeRequest } from "../src/integrations/gitlab";
import { ConversationStore } from "../src/stores/conversations";
import { IntegrationStore } from "../src/stores/integrations";
import { ProjectStore } from "../src/stores/projects";
import { TicketStore } from "../src/stores/tickets";

let projectId: string;
let integrations: IntegrationStore;
let tickets: TicketStore;
let conversations: ConversationStore;
let db: ReturnType<typeof openDb>;

const task: ClickUpTask = {
  id: "86caw5afd",
  key: "TECH-24657",
  title: "Leviers",
  status: "in progress",
  statusColor: "#4466ff",
  url: "https://app.clickup.com/t/86caw5afd",
  updatedAt: "2026-08-19T00:00:00.000Z",
  list: "Features",
  priority: "normal",
  labels: ["BackOffice"],
};

const reviewTask: ClickUpTask = {
  id: "86caw5zzz",
  key: "TECH-24868",
  title: "Facture",
  status: "open",
  statusColor: "#22aa66",
  url: "https://app.clickup.com/t/86caw5zzz",
  updatedAt: "2026-08-19T00:00:00.000Z",
  list: "Features",
  priority: "high",
  labels: ["Billing"],
};

const mine: GitLabMergeRequest = {
  iid: 1862,
  title: "TECH-24657 / Leviers",
  sourceBranch: "feature/TECH-24657",
  targetBranch: "develop",
  state: "opened",
  url: "https://git/x/1862",
  updatedAt: "2026-08-19T10:00:00Z",
  draft: false,
  hasConflicts: false,
  mergeStatus: "mergeable",
  labels: [],
  author: "clement.serizay",
  reviewers: [],
};

const toReview: GitLabMergeRequest = {
  ...mine,
  iid: 1868,
  title: "TECH-24868 / Facture",
  sourceBranch: "issue/TECH-24868-publisher",
  author: "louis.quellier",
  reviewers: ["clement.serizay"],
};

function fakeClickUp(tasks: ClickUpTask[] = [task]) {
  return {
    me: async () => 82632460,
    assignedTasks: async () => tasks,
    taskContext: async () => ({ description: "", comments: [] }),
  };
}

function fakeGitLab() {
  return {
    me: async () => ({ id: 123, username: "clement.serizay" }),
    projectId: async (path: string) => (path === "Affilae/symfony" ? 187 : 290),
    openMergeRequests: async (id: number) => (id === 187 ? [mine, toReview] : []),
    mergeRequest: async () => ({
      ...mine,
      iid: 1815,
      sourceBranch: "feature/TECH-23903",
      state: "merged",
    }),
    latestPipeline: async () => ({
      id: 119728,
      status: "manual",
      url: "https://git/p/119728",
      updatedAt: "2026-08-19T10:00:00Z",
      ref: "refs/merge-requests/1862/head",
      sha: "a",
    }),
    environmentByName: async (_projectId: number, name: string) => (name === "preprod" ? { id: 283, name } : null),
    lastDeployment: async () => ({
      ref: "refs/merge-requests/1815/head",
      mergeRequestIid: 1815,
      sha: "a",
      status: "success",
      createdAt: "2026-08-18T08:44:45Z",
      user: "theo.micaletti",
      job: "deploy:preprod",
      jobUrl: "u",
    }),
  };
}

function makeRefresher(
  overrides: Partial<ConstructorParameters<typeof IntegrationsRefresher>[1]> = {},
) {
  return new IntegrationsRefresher(
    { integrations, tickets, conversations, projects: new ProjectStore(db) },
    {
      clickUpClient: () => fakeClickUp() as any,
      gitLabClient: () => fakeGitLab() as any,
      ...overrides,
    },
  );
}

beforeEach(() => {
  db = openDb(mkdtempSync(join(tmpdir(), "pupitre-refresher-")));
  projectId = new ProjectStore(db).create({ name: "mono", path: "/tmp/mono" }).id;
  integrations = new IntegrationStore(db);
  tickets = new TicketStore(db);
  conversations = new ConversationStore(db);
  integrations.upsert(projectId, "clickup", {
    config: { teamId: "1", listIds: ["a"] },
    branchPattern: "^(issue|maintenance|feature)/(TECH-\\d+)",
  });
  integrations.upsert(projectId, "gitlab", {
    config: {
      host: "https://git.example",
      projects: [
        {
          path: "Affilae/symfony",
          label: "reactor",
          environments: ["preprod", "absente"],
        },
        { path: "Affilae/hapigator", label: "hapigator", environments: [] },
      ],
    },
    branchPattern: "^(issue|maintenance|feature)/(TECH-\\d+)",
  });
});

test("rapproche tâche ClickUp, MR, pipeline et déploiement sur la clé du ticket", async () => {
  const refresher = makeRefresher();
  const notified: string[] = [];

  refresher.subscribe((id) => notified.push(id));
  await refresher.refreshProject(projectId);

  const rows = tickets.listByProject(projectId);
  const linked = rows.find((row) => row.key === "TECH-24657");
  expect(linked).toBeDefined();
  expect(linked?.source).toBe("clickup");
  expect(linked?.status).toBe("in progress");
  expect(linked?.refs.map((ref) => ref.kind).sort()).toEqual(["branch", "mr", "pipeline"]);
  expect(linked?.refs.find((ref) => ref.kind === "mr")?.ref).toBe("reactor!1862");
  expect(linked?.refs.find((ref) => ref.kind === "pipeline")?.payload).toEqual(
    expect.objectContaining({ status: "manual" }),
  );

  const deployed = rows.find((row) => row.key === "TECH-23903");
  expect(deployed?.source).toBe("git");
  expect(deployed?.refs.find((ref) => ref.kind === "deployment")?.payload).toEqual(
    expect.objectContaining({ environment: "preprod", user: "theo.micaletti" }),
  );
  expect(rows.find((row) => row.key === "TECH-24868")).toBeUndefined();

  const gitlab = integrations.find(projectId, "gitlab");
  expect(gitlab?.status).toBe("ok");
  expect(gitlab?.snapshot.toReview).toEqual([
    expect.objectContaining({ iid: 1868, author: "louis.quellier" }),
  ]);
  expect(gitlab?.snapshot.environments).toEqual([
    expect.objectContaining({
      project: "reactor",
      name: "preprod",
      branch: "feature/TECH-23903",
      key: "TECH-23903",
      user: "theo.micaletti",
    }),
    expect.objectContaining({ project: "reactor", name: "absente", missing: true }),
  ]);
  expect(notified).toEqual([projectId]);
});

test("séquence ClickUp avant GitLab pour rattacher dès le premier refresh une MR non mienne à un ticket ClickUp", async () => {
  const refresher = makeRefresher({
    clickUpClient: () => ({
      ...fakeClickUp([task, reviewTask]),
      assignedTasks: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return [task, reviewTask];
      },
    }) as any,
  });

  await refresher.refreshProject(projectId);

  const linked = tickets.listByProject(projectId).find((row) => row.key === "TECH-24868");
  expect(linked?.source).toBe("clickup");
  expect(linked?.refs.find((ref) => ref.kind === "mr")?.ref).toBe("reactor!1868");
  expect(integrations.find(projectId, "gitlab")?.snapshot.toReview).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ iid: 1868, author: "louis.quellier" }),
    ]),
  );
});

test("une source en 401 passe à reconfigurer et n'efface rien ; l'autre continue", async () => {
  await makeRefresher().refreshProject(projectId);

  const refresher = makeRefresher({
    clickUpClient: () => ({
      ...fakeClickUp(),
      me: async () => {
        throw new ClickUpAuthError("401");
      },
    }) as any,
  });

  await refresher.refreshProject(projectId);

  expect(integrations.find(projectId, "clickup")?.status).toBe("à reconfigurer");
  expect(integrations.find(projectId, "gitlab")?.status).toBe("ok");
  expect(tickets.listByProject(projectId).find((row) => row.key === "TECH-24657")?.status).toBe("in progress");
});

test("une panne réseau passe en dégradée et garde les données", async () => {
  await makeRefresher().refreshProject(projectId);

  const refresher = makeRefresher({
    gitLabClient: () => ({
      ...fakeGitLab(),
      openMergeRequests: async () => {
        throw new TypeError("fetch failed");
      },
    }) as any,
  });

  await refresher.refreshProject(projectId);

  const gitlab = integrations.find(projectId, "gitlab");
  expect(gitlab?.status).toBe("dégradée");
  expect(gitlab?.last_error).toContain("fetch failed");
  expect(gitlab?.snapshot.environments).toHaveLength(2);
});

test("une intégration sans client reste non configurée", async () => {
  const refresher = makeRefresher({ clickUpClient: () => null });
  await refresher.refreshProject(projectId);
  expect(integrations.find(projectId, "clickup")?.status).toBe("non configurée");
});

test("clickup passe de ok à non configurée sans effacer snapshot ni tickets", async () => {
  await makeRefresher().refreshProject(projectId);

  const refresher = makeRefresher({ clickUpClient: () => null });
  await refresher.refreshProject(projectId);

  const clickup = integrations.find(projectId, "clickup");
  expect(clickup?.status).toBe("non configurée");
  expect(clickup?.snapshot).toEqual({ userId: 82632460, tasks: 1 });
  expect(tickets.listByProject(projectId).find((row) => row.key === "TECH-24657")?.status).toBe("in progress");
});

test("gitlab passe de ok à non configurée sans effacer snapshot ni tickets", async () => {
  await makeRefresher().refreshProject(projectId);

  const refresher = makeRefresher({ gitLabClient: () => null });
  await refresher.refreshProject(projectId);

  const gitlab = integrations.find(projectId, "gitlab");
  expect(gitlab?.status).toBe("non configurée");
  expect(gitlab?.snapshot.environments).toHaveLength(2);
  expect(tickets.listByProject(projectId).find((row) => row.key === "TECH-23903")?.source).toBe("git");
});

test("les conversations sur worktree créent des tickets git et se relient", async () => {
  const worktree = "/tmp/wt/feature-TECH-99";
  const conversation = conversations.create({
    projectId,
    provider: "claude",
    model: "m",
    firstMessage: "x",
    worktreePath: worktree,
  });
  const refresher = makeRefresher({
    clickUpClient: () => null,
    gitLabClient: () => null,
    branchOfWorktree: () => "feature/TECH-99",
  });

  await refresher.refreshProject(projectId);

  const row = tickets.listByProject(projectId).find((item) => item.key === "TECH-99");
  expect(row?.source).toBe("git");
  expect(row?.conversations.map((item) => item.id)).toEqual([conversation.id]);
  expect(conversations.get(conversation.id)?.ticket_id).toBe(row?.id);
});

test("start/stop relève immédiatement puis périodiquement sans double passage concurrent", async () => {
  let calls = 0;
  let running = 0;
  let maxRunning = 0;
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const refresher = makeRefresher({
    clickUpClient: () => ({
      ...fakeClickUp(),
      assignedTasks: async () => {
        calls += 1;
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await gate;
        running -= 1;
        return [task];
      },
    }) as any,
  });

  refresher.start(20);
  refresher.start(20);
  await new Promise((resolve) => setTimeout(resolve, 70));
  release?.();
  await new Promise((resolve) => setTimeout(resolve, 70));
  refresher.stop();

  expect(calls).toBeGreaterThanOrEqual(2);
  expect(maxRunning).toBe(1);
});

test("une demande pendant un refresh en cours rejoue le projet une seule fois après le premier", async () => {
  let calls = 0;
  let releaseFirst = () => {};
  let firstStartedResolve = () => {};
  const firstStarted = new Promise<void>((resolve) => {
    firstStartedResolve = resolve;
  });
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const refresher = makeRefresher({
    clickUpClient: () => ({
      ...fakeClickUp(),
      assignedTasks: async () => {
        calls += 1;
        if (calls === 1) {
          firstStartedResolve();
          await firstGate;
        }
        return [task];
      },
    }) as any,
  });

  const first = refresher.refreshProject(projectId);
  await firstStarted;
  const second = refresher.refreshProject(projectId);
  const third = refresher.refreshProject(projectId);
  releaseFirst();

  await Promise.all([first, second, third]);

  expect(calls).toBe(2);
});
