import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { MediaStore } from "../src/media";
import { ConversationRunner } from "../src/runner";
import { ConversationEventBus, createServer, type ServerDeps } from "../src/server";
import { ConversationStore } from "../src/stores/conversations";
import { ProjectStore } from "../src/stores/projects";
import { PresetStore } from "../src/stores/presets";
import { INTEGRATION_TOKENS_KEY, SettingsStore } from "../src/stores/settings";
import { QuotaTracker } from "../src/quotas";
import { QuotaRefresher } from "../src/quota-refresh";
import { SubtaskRunner } from "../src/subtasks";
import { ReviewStore } from "../src/stores/reviews";
import { ReviewRunner } from "../src/reviews";
import { DebriefStore } from "../src/stores/debriefs";
import { DebriefRunner } from "../src/debriefs";
import { GitProjectService } from "../src/git";
import { TestingStore } from "../src/stores/testing";
import { TesterRunner } from "../src/testing";
import { SkillInventory } from "../src/skills";
import { SkillSuggestionService } from "../src/skill-suggestions";
import { SkillComposer } from "../src/skill-composer";
import { WorkflowStore } from "../src/stores/workflows";
import { NotificationStore } from "../src/stores/notifications";
import { RoutineScheduler, RoutineStore } from "../src/routines";
import { SearchIndex } from "../src/search";
import { CostStore } from "../src/costs";
import { MemoryStore } from "../src/memory";
import { HtmlDocumentService } from "../src/html-documents";
import { IntegrationStore } from "../src/stores/integrations";
import { TicketStore } from "../src/stores/tickets";
import { IntegrationsRefresher } from "../src/integrations/refresher";

interface TestServer {
  baseUrl: string;
  db: Database;
  server: ReturnType<typeof createServer>;
  deps: ServerDeps;
}

let current: TestServer | undefined;
let previousClaudeBin: string | undefined;
let previousCodexBin: string | undefined;
let previousClaudeStdinFile: string | undefined;
let previousPromptLog: string | undefined;

function jsonHeaders(): HeadersInit {
  return { "content-type": "application/json" };
}

async function postJson(path: string, body: unknown): Promise<Response> {
  if (!current) throw new Error("serveur de test non démarré");
  return fetch(`${current.baseUrl}${path}`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  });
}

async function putJson(path: string, body: unknown): Promise<Response> {
  if (!current) throw new Error("serveur de test non démarré");
  return fetch(`${current.baseUrl}${path}`, {
    method: "PUT",
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  });
}

async function createProject(path: string): Promise<{ id: string }> {
  mkdirSync(path, { recursive: true });
  const response = await postJson("/api/projects", { name: "test", path });
  expect(response.status).toBe(201);
  return response.json();
}

function runGit(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

async function waitForRunnerIdle(conversationId: string): Promise<void> {
  if (!current) throw new Error("serveur de test non démarré");
  const deadline = Date.now() + 3_000;
  while (current.deps.runner.isRunning(conversationId) && Date.now() < deadline) {
    await Bun.sleep(20);
  }
  if (current.deps.runner.isRunning(conversationId)) {
    throw new Error("timeout runner actif");
  }
}

function webSocketEventWaiter(
  url: string,
  predicate: (event: Record<string, unknown>) => boolean,
): { opened: Promise<void>; event: Promise<Record<string, unknown>> } {
  let markOpened!: () => void;
  const opened = new Promise<void>((resolve) => {
    markOpened = resolve;
  });
  const event = new Promise<Record<string, unknown>>((resolve, reject) => {
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("timeout WebSocket"));
    }, 3_000);

    socket.addEventListener("open", markOpened);
    socket.addEventListener("message", (message) => {
      const payload = JSON.parse(String(message.data)) as Record<string, unknown>;
      if (!predicate(payload)) return;
      clearTimeout(timeout);
      socket.close();
      resolve(payload);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("erreur WebSocket"));
    });
  });
  return { opened, event };
}

beforeEach(() => {
  current = undefined;
  const dir = mkdtempSync(join(tmpdir(), "pupitre-dashboard-"));
  previousClaudeBin = process.env.PUPITRE_CLAUDE_BIN;
  previousCodexBin = process.env.PUPITRE_CODEX_BIN;
  previousClaudeStdinFile = process.env.FAKE_CLAUDE_STDIN_FILE;
  previousPromptLog = process.env.PUPITRE_FAKE_PROMPT_LOG;
  process.env.PUPITRE_CLAUDE_BIN = join(import.meta.dir, "fake-bins/fake-claude");
  process.env.PUPITRE_CODEX_BIN = join(import.meta.dir, "fake-bins/fake-codex");

  const db = openDb(dir);
  const projects = new ProjectStore(db);
  const conversations = new ConversationStore(db);
  const media = new MediaStore(dir);
  const events = new ConversationEventBus();
  const htmlDocuments = new HtmlDocumentService(
    db,
    dir,
    conversations,
    projects,
    events.broadcast,
  );
  const quotas = new QuotaTracker(db);
  const runner = new ConversationRunner(
    conversations,
    projects,
    media,
    events.broadcast,
    quotas,
    () => 4321,
  );
  const subtasks = new SubtaskRunner(db, conversations, projects, events.broadcast, quotas);
  const presets = new PresetStore(db);
  const settings = new SettingsStore(db);
  const reviewStore = new ReviewStore(db);
  const reviews = new ReviewRunner(
    reviewStore,
    projects,
    conversations,
    quotas,
    async () => "{\"flags\":[]}",
    subtasks,
  );
  const debriefs = new DebriefRunner(
    new DebriefStore(db),
    conversations,
    projects,
    quotas,
    events.broadcast,
    async () => "## Résumé\n\nOK.",
    runner.activity,
  );
  const testers = new TesterRunner(
    new TestingStore(db),
    conversations,
    projects,
    reviewStore,
    quotas,
    events.broadcast,
    subtasks,
    async () => "{\"items\":[]}",
    runner.activity,
  );
  const skills = new SkillInventory(db, projects, { homeDir: dir });
  skills.refresh();
  const skillSuggestions = new SkillSuggestionService(skills, projects, quotas, async () => []);
  const skillComposer = new SkillComposer(skills, projects, quotas, {
    homeDir: dir,
    generator: async () => JSON.stringify({
      name: "skill-api",
      description: "Use quand l'API doit être vérifiée.",
      content: "# Skill API\n\nVérifie le contrat HTTP.",
    }),
  });
  const workflows = new WorkflowStore(db);
  const notifications = new NotificationStore(db);
  const routineStore = new RoutineStore(db);
  const routines = new RoutineScheduler(
    routineStore,
    workflows,
    presets,
    projects,
    conversations,
    runner,
    notifications,
  );
  const integrations = new IntegrationStore(db);
  const tickets = new TicketStore(db);
  const integrationsRefresher = new IntegrationsRefresher(
    { integrations, tickets, conversations, projects },
    { clickUpClient: () => null, gitLabClient: () => null },
  );
  const deps: ServerDeps = {
    port: 0,
    projects,
    conversations,
    media,
    runner,
    events,
    quotas,
    quotaRefresher: new QuotaRefresher(quotas, {
      readCodexRateLimits: async () => null,
      readClaudeUsage: async () => null,
    }),
    subtasks,
    presets,
    settings,
    reviews,
    debriefs,
    git: new GitProjectService(db, projects, { worktreeRoot: join(dir, "worktrees") }),
    testers,
    skills,
    skillSuggestions,
    skillComposer,
    workflows,
    notifications,
    routineStore,
    routines,
    search: new SearchIndex(db),
    costs: new CostStore(db),
    memory: new MemoryStore(join(dir, "memory")),
    htmlDocuments,
    integrations,
    tickets,
    integrationsRefresher,
  };
  const server = createServer(deps);
  current = {
    baseUrl: `http://127.0.0.1:${server.port}`,
    db,
    server,
    deps,
  };
});

afterEach(() => {
  current?.server.stop(true);
  current?.db.close();
  current = undefined;
  if (previousClaudeBin === undefined) delete process.env.PUPITRE_CLAUDE_BIN;
  else process.env.PUPITRE_CLAUDE_BIN = previousClaudeBin;
  if (previousCodexBin === undefined) delete process.env.PUPITRE_CODEX_BIN;
  else process.env.PUPITRE_CODEX_BIN = previousCodexBin;
  if (previousClaudeStdinFile === undefined) delete process.env.FAKE_CLAUDE_STDIN_FILE;
  else process.env.FAKE_CLAUDE_STDIN_FILE = previousClaudeStdinFile;
  if (previousPromptLog === undefined) delete process.env.PUPITRE_FAKE_PROMPT_LOG;
  else process.env.PUPITRE_FAKE_PROMPT_LOG = previousPromptLog;
});

test("CRUD des intégrations d'un projet et validation du motif", async () => {
  const project = await createProject("/tmp/dash-1");

  const put = await putJson(`/api/projects/${project.id}/integrations/gitlab`, {
    config: { host: "https://git.example", projects: [] },
    branchPattern: "^(issue|feature)/(TECH-\\d+)",
  });
  expect(put.status).toBe(200);

  const list = await fetch(`${current!.baseUrl}/api/projects/${project.id}/integrations`)
    .then((response) => response.json()) as Array<Record<string, unknown>>;
  expect(list).toHaveLength(1);
  expect(list[0]).toEqual(expect.objectContaining({
    type: "gitlab",
    status: "non configurée",
  }));

  const bad = await putJson(`/api/projects/${project.id}/integrations/gitlab`, {
    config: {},
    branchPattern: "(",
  });
  expect(bad.status).toBe(400);

  const del = await fetch(`${current!.baseUrl}/api/projects/${project.id}/integrations/gitlab`, {
    method: "DELETE",
  });
  expect(del.status).toBe(204);
});

test("les tokens d'intégration s'écrivent dans settings sans jamais être relus par GET", async () => {
  const put = await putJson("/api/settings", {
    [INTEGRATION_TOKENS_KEY]: { clickup: "pk_secret", gitlab: "glpat-secret" },
  });
  expect(put.status).toBe(200);

  const settings = await fetch(`${current!.baseUrl}/api/settings`).then((response) => response.json()) as {
    integrationTokens: Record<string, boolean>;
  };
  expect(settings.integrationTokens).toEqual({ clickup: true, gitlab: true });
  expect(JSON.stringify(settings)).not.toContain("pk_secret");
});

test("dashboard : tickets, notes, refresh et canal WS", async () => {
  const project = await createProject("/tmp/dash-2");
  const ticket = current!.deps.tickets.upsert(project.id, {
    key: "TECH-1",
    source: "git",
    title: "b",
    status: "",
    externalUrl: null,
  });

  const initial = await fetch(`${current!.baseUrl}/api/projects/${project.id}/dashboard`)
    .then((response) => response.json()) as {
      refreshedAt: string;
      tickets: Array<{ key: string }>;
    };
  expect(initial.tickets.map((row) => row.key)).toEqual(["TECH-1"]);

  const waiter = webSocketEventWaiter(
    `${current!.baseUrl.replace("http", "ws")}/ws?channel=tickets&project=${project.id}`,
    (event) => {
      const tickets = event.tickets;
      if (!Array.isArray(tickets)) return false;
      const refreshedAt = event.refreshedAt;
      return typeof refreshedAt === "string"
        && refreshedAt !== initial.refreshedAt
        && typeof tickets[0] === "object"
        && tickets[0] !== null
        && (tickets[0] as { notes_count?: unknown }).notes_count === 1;
    },
  );
  await waiter.opened;

  const note = await postJson(`/api/tickets/${ticket.id}/notes`, { body: "penser au cache" });
  expect(note.status).toBe(201);

  const refresh = await postJson(`/api/projects/${project.id}/dashboard/refresh`, {});
  expect(refresh.status).toBe(202);
  await waiter.event;
});

test("GET /api/conversations/:id/brief rend titre, résumé, dernier débrief et derniers échanges", async () => {
  const project = await createProject("/tmp/brief-1");
  const conversation = current!.deps.conversations.create({
    projectId: project.id,
    provider: "claude",
    model: "m",
    firstMessage: "Bonjour",
  });
  current!.deps.conversations.updateDigest(conversation.id, {
    title: "Reprise tableau de bord",
    summary: "Résumé utile",
  }, 1);
  current!.deps.conversations.appendEvent(conversation.id, {
    type: "user-message",
    text: "Bonjour",
    images: [],
  });
  current!.deps.conversations.appendEvent(conversation.id, {
    type: "text-final",
    text: "Salut, voici le plan.",
  });

  const response = await fetch(`${current!.baseUrl}/api/conversations/${conversation.id}/brief`);
  expect(response.status).toBe(200);

  const brief = await response.json() as {
    id: string;
    title: string;
    summary: string;
    debrief: string | null;
    exchanges: Array<{ role: string; text: string }>;
  };
  expect(brief).toEqual(expect.objectContaining({
    id: conversation.id,
    title: "Reprise tableau de bord",
    summary: "Résumé utile",
    debrief: null,
  }));
  expect(brief.exchanges.at(-1)).toEqual({ role: "assistant", text: "Salut, voici le plan." });
});

test("POST /api/conversations avec ticketId relie la conversation, prend la branche du ticket et injecte le brief", async () => {
  const repoPath = mkdtempSync(join(tmpdir(), "pupitre-dashboard-ticket-"));
  runGit(repoPath, "init", "-q", "-b", "main");
  runGit(repoPath, "config", "user.email", "api@example.test");
  runGit(repoPath, "config", "user.name", "API Git");
  writeFileSync(join(repoPath, "README.md"), "base\n");
  runGit(repoPath, "add", "README.md");
  runGit(repoPath, "commit", "-qm", "base");

  const project = await createProject(repoPath);
  const ticket = current!.deps.tickets.upsert(project.id, {
    key: "TECH-7",
    source: "git",
    title: "b",
    status: "",
    externalUrl: null,
  });
  current!.deps.tickets.upsertRef(ticket.id, {
    kind: "branch",
    ref: "feature/TECH-7",
    payload: {},
  });
  const fakeClaudePromptLog = join(repoPath, "fake-claude-stdin.log");
  process.env.PUPITRE_FAKE_PROMPT_LOG = fakeClaudePromptLog;

  const created = await postJson("/api/conversations", {
    projectId: project.id,
    provider: "claude",
    model: "claude-fable-5",
    message: "On reprend",
    ticketId: ticket.id,
  });
  expect(created.status).toBe(201);

  const conversation = await created.json() as {
    id: string;
    ticket_id: string | null;
    worktree_path: string | null;
  };
  expect(conversation.ticket_id).toBe(ticket.id);
  expect(conversation.worktree_path).toContain("feature-TECH-7");

  await waitForRunnerIdle(conversation.id);

  const events = current!.deps.conversations.listEvents(conversation.id);
  const userMessage = events.find((event) => event.type === "user-message");
  expect(userMessage).toMatchObject({ type: "user-message", text: "On reprend" });
  const sent = readFileSync(fakeClaudePromptLog, "utf8");
  expect(sent).toContain("# Reprise du ticket TECH-7");
});
