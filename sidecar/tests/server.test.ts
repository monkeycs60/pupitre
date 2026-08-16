import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import type { AppEvent, StoredEvent } from "../src/events";
import { MediaStore } from "../src/media";
import { ConversationRunner } from "../src/runner";
import { claimServer, ConversationEventBus, createServer, type ServerDeps } from "../src/server";
import { ConversationStore } from "../src/stores/conversations";
import { ProjectStore } from "../src/stores/projects";
import { PresetStore } from "../src/stores/presets";
import { SettingsStore } from "../src/stores/settings";
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

interface TestServer {
  baseUrl: string;
  db: Database;
  runner: ConversationRunner;
  server: ReturnType<typeof createServer>;
  reviews: ReviewRunner;
  subtasks: SubtaskRunner;
  deps: ServerDeps;
  shutdownCalls: () => number;
}

let current: TestServer | undefined;
let previousClaudeBin: string | undefined;
let previousCodexBin: string | undefined;
/** Relevés que les lectures scriptées du QuotaRefresher rendront (cf. beforeEach). */
let claudeUsageProbe: unknown = null;
let codexRateLimitsProbe: unknown = null;
let claudeProbeCount = 0;

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
  const response = await postJson("/api/projects", { name: "test", path });
  expect(response.status).toBe(201);
  return response.json();
}

function runGit(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

async function waitForPersistedEvent(
  conversationId: string,
  predicate: (event: AppEvent) => boolean,
): Promise<StoredEvent> {
  if (!current) throw new Error("serveur de test non démarré");
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const response = await fetch(
      `${current.baseUrl}/api/conversations/${conversationId}/events`,
    );
    const events = await response.json() as StoredEvent[];
    const event = events.find(predicate);
    if (event) return event;
    await Bun.sleep(20);
  }
  throw new Error("timeout événement persisté");
}

async function waitForRunnerIdle(conversationId: string): Promise<void> {
  if (!current) throw new Error("serveur de test non démarré");
  const deadline = Date.now() + 3_000;
  while (current.runner.isRunning(conversationId) && Date.now() < deadline) {
    await Bun.sleep(20);
  }
  if (current.runner.isRunning(conversationId)) {
    throw new Error("timeout runner actif");
  }
}

function webSocketEventWaiter(
  url: string,
  predicate: (event: AppEvent) => boolean,
): { opened: Promise<void>; event: Promise<StoredEvent> } {
  let markOpened!: () => void;
  const opened = new Promise<void>((resolve) => {
    markOpened = resolve;
  });
  const event = new Promise<StoredEvent>((resolve, reject) => {
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("timeout WebSocket"));
    }, 3_000);

    socket.addEventListener("open", markOpened);
    socket.addEventListener("message", (message) => {
      const event = JSON.parse(String(message.data)) as StoredEvent;
      if (!predicate(event)) return;
      clearTimeout(timeout);
      socket.close();
      resolve(event);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("erreur WebSocket"));
    });
  });
  return { opened, event };
}

function collectWebSocketEvents(
  url: string,
  isLast: (event: AppEvent) => boolean,
): Promise<StoredEvent[]> {
  return new Promise((resolve, reject) => {
    const collected: StoredEvent[] = [];
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("timeout WebSocket"));
    }, 3_000);

    socket.addEventListener("message", (message) => {
      const event = JSON.parse(String(message.data)) as StoredEvent;
      collected.push(event);
      if (!isLast(event)) return;
      clearTimeout(timeout);
      socket.close();
      resolve(collected);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("erreur WebSocket"));
    });
  });
}

beforeEach(() => {
  current = undefined;
  const dir = mkdtempSync(join(tmpdir(), "pupitre-server-"));
  const fakeClaude = join(dir, "fake-claude");
  const fixture = join(import.meta.dir, "fixtures/claude-basic.jsonl");
writeFileSync(fakeClaude, `#!/usr/bin/env bash
IFS= read -r initial
case "$initial" in
  *DECONNECTE_WS*) sleep 0.5 ;;
  *CONCURRENT_SAME*) sleep 0.3 ;;
  *ATTENDS_WS*) sleep 0.2 ;;
  *certitude*) sleep 0.2 ;;
  *BLOQUE*) exec sleep 30 ;;
esac
if [ -n "$FAKE_CLAUDE_ARGS_FILE" ]; then printf '%s\n' "$*" >> "$FAKE_CLAUDE_ARGS_FILE"; fi
cat "${fixture}"
`);
  chmodSync(fakeClaude, 0o755);
  claudeUsageProbe = null;
  codexRateLimitsProbe = null;
  claudeProbeCount = 0;
  previousClaudeBin = process.env.PUPITRE_CLAUDE_BIN;
  previousCodexBin = process.env.PUPITRE_CODEX_BIN;
  process.env.PUPITRE_CLAUDE_BIN = fakeClaude;
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
  // Racine de worktrees confinée au dossier temporaire du test : sans elle, le
  // service écrirait dans le vrai ~/.local/share/pupitre de l'utilisateur.
  const gitView = new GitProjectService(db, projects, {
    worktreeRoot: join(dir, "worktrees"),
  });
  const reviewStore = new ReviewStore(db);
  const reviews = new ReviewRunner(
    reviewStore,
    projects,
    conversations,
    quotas,
    async () => '{"flags":[]}',
    subtasks,
  );
  const debriefs = new DebriefRunner(
    new DebriefStore(db),
    conversations,
    projects,
    quotas,
    events.broadcast,
    async (input) => input.prompt.includes("résumé de session")
      ? [
        "## Implémenté",
        "- Le résumé court est disponible [événement #1].",
        "## À terminer",
        "- Vérifier le parcours de passation.",
      ].join("\n\n")
      : [
      "## Ce qui a été construit",
      "Un socle local.",
      "## Décisions et pourquoi",
      "SQLite est retenu [événement #1].",
      "## Alternatives écartées",
      "Postgres.",
      "## Implications",
      "Le produit reste local-first.",
      "## Points ouverts",
      "Aucun.",
      ].join("\n\n"),
    runner.activity,
  );
  const testers = new TesterRunner(
    new TestingStore(db), conversations, projects, reviewStore, quotas,
    events.broadcast, subtasks,
    async () => JSON.stringify({ items: [{
      title: "Endpoint API",
      description: "Vérifier le contrat et les erreurs.",
      methods: [{ kind: "unit", label: "Tests unitaires", instructions: "bun test" }],
      guardian_flag_ids: [],
    }] }),
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
    routineStore, workflows, presets, projects, conversations, runner, notifications,
  );
  let shutdownCount = 0;
  const deps: ServerDeps = {
    port: 0,
    projects,
    conversations,
    media,
    runner,
    events,
    quotas,
    // Les deux relevés sont scriptés : la vraie lecture claude taperait l'API
    // Anthropic, et la lecture codex parlerait à l'app-server.
    quotaRefresher: new QuotaRefresher(quotas, {
      readCodexRateLimits: async () => codexRateLimitsProbe,
      readClaudeUsage: async () => {
        claudeProbeCount += 1;
        return claudeUsageProbe;
      },
    }),
    subtasks,
    presets,
    settings,
    reviews,
    debriefs,
    git: gitView,
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
    shutdown: () => {
      shutdownCount += 1;
    },
  };
  const server = createServer(deps);
  current = {
    baseUrl: `http://127.0.0.1:${server.port}`,
    db,
    runner,
    server,
    reviews,
    subtasks,
    deps,
    shutdownCalls: () => shutdownCount,
  };
});

/** Dépôts temporaires à retirer : sans ça, chaque exécution en laisse un. */
const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
  current?.server.stop(true);
  current?.db.close();
  current = undefined;
  if (previousClaudeBin === undefined) delete process.env.PUPITRE_CLAUDE_BIN;
  else process.env.PUPITRE_CLAUDE_BIN = previousClaudeBin;
  if (previousCodexBin === undefined) delete process.env.PUPITRE_CODEX_BIN;
  else process.env.PUPITRE_CODEX_BIN = previousCodexBin;
  delete process.env.FAKE_CLAUDE_ARGS_FILE;
  delete process.env.PUPITRE_CODEX_MODE;
});

test("POST /api/shutdown répond puis déclenche l'arrêt câblé", async () => {
  if (!current) throw new Error("serveur de test non démarré");
  const response = await fetch(`${current.baseUrl}/api/shutdown`, { method: "POST" });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  // L'arrêt est différé pour laisser partir la réponse HTTP.
  expect(await waitFor(() => current!.shutdownCalls() === 1)).toBe(true);
});

test("claimServer évince un sidecar périmé qui tient le port", async () => {
  if (!current) throw new Error("serveur de test non démarré");
  // Simule un VIEUX sidecar : il tient un port, répond au health check et
  // s'arrête quand on le lui demande — comme le fera tout sidecar à jour.
  let oldSidecar: ReturnType<typeof Bun.serve> | null = null;
  oldSidecar = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === "/api/health") return Response.json({ ok: true });
      if (pathname === "/api/shutdown" && request.method === "POST") {
        setTimeout(() => oldSidecar?.stop(true), 10);
        return Response.json({ ok: true });
      }
      return new Response(null, { status: 404 });
    },
  });
  const contestedPort = oldSidecar.port!;

  const server = await claimServer(
    () => createServer({ ...current!.deps, port: contestedPort }),
    contestedPort,
  );
  try {
    expect(server.port).toBe(contestedPort);
    const health = await fetch(`http://127.0.0.1:${contestedPort}/api/health`);
    expect(await health.json()).toEqual({ ok: true });
  } finally {
    server.stop(true);
  }
});

test("claimServer échoue lisiblement si le port est tenu par un inconnu", async () => {
  if (!current) throw new Error("serveur de test non démarré");
  // Un process quelconque (pas un sidecar Pupitre : pas de /api/health).
  const stranger = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(null, { status: 404 }),
  });
  try {
    await expect(
      claimServer(() => createServer({ ...current!.deps, port: stranger.port! }), stranger.port!),
    ).rejects.toThrow(/occupé/);
  } finally {
    stranger.stop(true);
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(20);
  }
  return predicate();
}

test("health, création et liste des projets, avec 400 pour un path inexistant", async () => {
  if (!current) throw new Error("serveur de test non démarré");
  const health = await fetch(`${current.baseUrl}/api/health`);
  expect(health.status).toBe(200);
  expect(await health.json()).toEqual({ ok: true });

  const invalid = await postJson("/api/projects", {
    name: "absent",
    path: join(tmpdir(), crypto.randomUUID()),
  });
  expect(invalid.status).toBe(400);

  const project = await createProject(tmpdir());
  const list = await fetch(`${current.baseUrl}/api/projects`);
  expect(list.status).toBe(200);
  expect(await list.json()).toEqual([
    expect.objectContaining({ id: project.id, name: "test", path: tmpdir() }),
  ]);
});

test("API skills : refresh, filtres, détail et favori par projet", async () => {
  if (!current) throw new Error("serveur de test non démarré");
  const projectPath = mkdtempSync(join(tmpdir(), "pupitre-server-skills-"));
  writeFileSync(join(projectPath, "AGENTS.md"), "# Consignes API\n\nSkill indexé du projet.\n");
  const project = await createProject(projectPath);

  const refresh = await postJson("/api/skills/refresh", {});
  expect(refresh.status).toBe(200);
  expect(await refresh.json()).toEqual({ count: 1 });

  const list = await fetch(
    `${current.baseUrl}/api/skills?provider=codex&projectId=${project.id}&q=consignes`,
  );
  expect(list.status).toBe(200);
  const skills = await list.json() as Array<{ id: string; favorite: boolean; content_md?: string }>;
  expect(skills).toHaveLength(1);
  expect(skills[0]?.favorite).toBe(false);
  expect(skills[0]?.content_md).toBeUndefined();
  const skillId = skills[0]?.id;
  if (!skillId) throw new Error("skill API absent");

  const favorite = await putJson(
    `/api/projects/${project.id}/skills/${skillId}/favorite`,
    { favorite: true },
  );
  expect(favorite.status).toBe(204);
  const favoriteList = await fetch(
    `${current.baseUrl}/api/skills?favoriteProjectId=${project.id}`,
  );
  expect(favoriteList.status).toBe(200);
  expect(await favoriteList.json()).toEqual([
    expect.objectContaining({ id: skillId, favorite: true }),
  ]);
  const detail = await fetch(
    `${current.baseUrl}/api/skills/${skillId}?projectId=${project.id}`,
  );
  expect(detail.status).toBe(200);
  expect(await detail.json()).toMatchObject({
    id: skillId,
    favorite: true,
    content_md: "# Consignes API\n\nSkill indexé du projet.\n",
  });
  const suggestions = await postJson("/api/skills/suggestions", {
    projectId: project.id,
    text: "applique les consignes du projet",
    resolveAmbiguous: true,
  });
  expect(suggestions.status).toBe(200);
  expect(await suggestions.json()).toMatchObject({
    suggestions: [expect.objectContaining({ id: skillId })],
    resolvedByModel: false,
  });
  const generated = await postJson("/api/skills/generate", {
    projectId: project.id,
    description: "Vérifier les contrats API",
    scope: "global",
  });
  expect(generated.status).toBe(201);
  const generatedSkill = await generated.json() as { id: string; name: string };
  expect(generatedSkill).toMatchObject({
    name: "skill-api",
    provenance: "claude-global",
    project_id: null,
  });

  const workflowResponse = await postJson("/api/workflows", {
    projectId: project.id,
    name: "Vérification API",
    skillId: generatedSkill.id,
    prompt: "Vérifie les routes critiques.",
    presetId: "builtin-quality",
  });
  expect(workflowResponse.status).toBe(201);
  const workflow = await workflowResponse.json() as { id: string };
  const workflowList = await fetch(`${current.baseUrl}/api/projects/${project.id}/workflows`);
  expect(await workflowList.json()).toEqual([
    expect.objectContaining({ id: workflow.id, skill_invocation: "skill-api" }),
  ]);

  const run = await postJson(`/api/workflows/${workflow.id}/run`, {});
  expect(run.status).toBe(201);
  const workflowConversation = await run.json() as { id: string };
  await waitForRunnerIdle(workflowConversation.id);
  const events = await fetch(
    `${current.baseUrl}/api/conversations/${workflowConversation.id}/events`,
  ).then((response) => response.json()) as AppEvent[];
  expect(events[0]).toMatchObject({
    type: "user-message",
    text: "$skill-api\n\nVérifie les routes critiques.",
  });
});

test("expose le graphe Git et un diff entre deux références", async () => {
  if (!current) throw new Error("serveur de test non démarré");
  const repo = mkdtempSync(join(tmpdir(), "pupitre-server-git-"));
  runGit(repo, "init", "-q", "-b", "main");
  runGit(repo, "config", "user.email", "api@example.test");
  runGit(repo, "config", "user.name", "API Git");
  writeFileSync(join(repo, "value.txt"), "one\n");
  runGit(repo, "add", ".");
  runGit(repo, "commit", "-qm", "base");
  const base = runGit(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "value.txt"), "one\ntwo\n");
  runGit(repo, "commit", "-qam", "head");
  const head = runGit(repo, "rev-parse", "HEAD");
  const project = await createProject(repo);

  const graph = await fetch(`${current.baseUrl}/api/projects/${project.id}/git`);
  expect(graph.status).toBe(200);
  expect(await graph.json()).toMatchObject({
    head,
    currentBranch: "main",
    commits: [expect.objectContaining({ sha: head }), expect.objectContaining({ sha: base })],
  });

  const diff = await fetch(
    `${current.baseUrl}/api/projects/${project.id}/git/diff?base=${base}&head=${head}`,
  );
  expect(diff.status).toBe(200);
  expect(await diff.json()).toMatchObject({ base, head, diff: expect.stringContaining("+two") });

  const invalid = await fetch(
    `${current.baseUrl}/api/projects/${project.id}/git/diff?base=absent&head=HEAD`,
  );
  expect(invalid.status).toBe(400);
});

test("POST /api/quotas/refresh relève les deux providers et rend le snapshot", async () => {
  if (!current) throw new Error("serveur de test non démarré");
  const vide = await fetch(`${current.baseUrl}/api/quotas`);
  expect(await vide.json()).toEqual({ claude: null, codex: null });

  const resetsAt = Math.floor(Date.now() / 1000) + 3_600;
  const resetsAtIso = new Date(resetsAt * 1000).toISOString();
  claudeUsageProbe = {
    limits: [
      { kind: "session", percent: 13, resets_at: resetsAtIso, scope: null },
      {
        kind: "weekly_scoped",
        percent: 6,
        resets_at: resetsAtIso,
        scope: { model: { display_name: "Fable" } },
      },
    ],
  };
  codexRateLimitsProbe = {
    primary: { usedPercent: 42, windowDurationMins: 300, resetsAt },
    secondary: null,
  };

  const refreshed = await fetch(`${current.baseUrl}/api/quotas/refresh`, { method: "POST" });
  expect(refreshed.status).toBe(200);
  const snapshot = await refreshed.json() as {
    claude: { windows: { label: string; usedPercent: number | null }[] } | null;
    codex: { windows: { usedPercent: number | null }[] } | null;
  };
  // Le relevé OAuth porte de vrais pourcentages, dont une fenêtre par modèle.
  expect(snapshot.claude?.windows).toEqual([
    expect.objectContaining({ label: "five_hour", usedPercent: 13 }),
    expect.objectContaining({ label: "seven_day_fable", usedPercent: 6 }),
  ]);
  expect(snapshot.codex?.windows[0]).toEqual(
    expect.objectContaining({ usedPercent: 42 }),
  );
  expect(claudeProbeCount).toBe(1);

  // La lecture est gratuite : un rafraîchissement explicite relève sans condition.
  await fetch(`${current.baseUrl}/api/quotas/refresh`, { method: "POST" });
  expect(claudeProbeCount).toBe(2);
});

test("CRUD des presets, intégrés éditables et restaurables, défaut par projet", async () => {
  if (!current) throw new Error("serveur de test non démarré");
  const initial = await fetch(`${current.baseUrl}/api/presets`);
  expect(initial.status).toBe(200);
  const builtIns = await initial.json() as Array<{ id: string; name: string }>;
  expect(builtIns.map((preset) => preset.name)).toEqual(["Éco", "Qualité max", "Vitesse"]);

  const created = await postJson("/api/presets", {
    name: "Revue",
    provider: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
    speed: "standard",
    orchestrator: true,
    permission_mode: "autonomous",
    review_provider: "claude",
    review_model: "opus",
    review_effort: "high",
  });
  expect(created.status).toBe(201);
  const preset = await created.json() as { id: string };

  const updated = await putJson(`/api/presets/${preset.id}`, {
    name: "Revue rapide",
    provider: "codex",
    model: "gpt-5.6-luna",
    effort: "medium",
    speed: "fast",
    orchestrator: false,
  });
  expect(updated.status).toBe(200);
  expect(await updated.json()).toEqual(expect.objectContaining({
    name: "Revue rapide",
    permission_mode: "bypassPermissions",
    review_provider: "claude",
    review_model: "opus",
    review_effort: "high",
  }));

  const invalidPermission = await postJson("/api/presets", {
    name: "Permission invalide",
    provider: "codex",
    model: "gpt-5.6-luna",
    effort: "low",
    speed: "standard",
    orchestrator: true,
    permission_mode: "confirm-everything",
  });
  expect(invalidPermission.status).toBe(400);

  const project = await createProject(tmpdir());
  expect(project).toEqual(expect.objectContaining({
    filesystem_scope: "project-and-ai-roots",
  }));
  const fullFilesystem = await putJson(
    `/api/projects/${project.id}/filesystem-scope`,
    { scope: "full-system" },
  );
  expect(fullFilesystem.status).toBe(200);
  expect(await fullFilesystem.json()).toEqual(expect.objectContaining({
    filesystem_scope: "full-system",
  }));
  const selected = await putJson(`/api/projects/${project.id}/default-preset`, {
    presetId: preset.id,
  });
  expect(selected.status).toBe(200);
  const selectedProject = await selected.json();
  expect(selectedProject).toEqual(expect.objectContaining({ default_preset_id: preset.id }));
  expect(selectedProject).toEqual(expect.objectContaining({
    permission_mode: "bypassPermissions",
  }));

  const selectedReview = await putJson(`/api/projects/${project.id}/default-review-preset`, {
    presetId: preset.id,
  });
  expect(selectedReview.status).toBe(200);
  expect(await selectedReview.json()).toEqual(expect.objectContaining({
    default_review_preset_id: preset.id,
  }));
  const selectedCorrection = await putJson(`/api/projects/${project.id}/default-correction-preset`, {
    presetId: preset.id,
  });
  expect(selectedCorrection.status).toBe(200);
  expect(await selectedCorrection.json()).toEqual(expect.objectContaining({
    default_correction_preset_id: preset.id,
  }));

  const editedBuiltIn = await putJson(`/api/presets/${builtIns[0]!.id}`, {
    name: "Éco maison",
    provider: "claude",
    model: "haiku",
    effort: "low",
    speed: null,
    orchestrator: false,
  });
  expect(editedBuiltIn.status).toBe(200);
  expect(await editedBuiltIn.json()).toEqual(expect.objectContaining({
    name: "Éco maison",
    model: "haiku",
    built_in: true,
  }));

  const restored = await fetch(
    `${current.baseUrl}/api/presets/${builtIns[0]!.id}/restore`,
    { method: "POST" },
  );
  expect(restored.status).toBe(200);
  expect(await restored.json()).toEqual(expect.objectContaining({
    name: "Éco",
    model: "gpt-5.6-luna",
  }));

  const undeletable = await fetch(`${current.baseUrl}/api/presets/${builtIns[0]!.id}`, {
    method: "DELETE",
  });
  expect(undeletable.status).toBe(409);

  const deleted = await fetch(`${current.baseUrl}/api/presets/${preset.id}`, {
    method: "DELETE",
  });
  expect(deleted.status).toBe(204);
  const projects = await fetch(`${current.baseUrl}/api/projects`);
  expect(await projects.json()).toEqual([
    expect.objectContaining({ id: project.id, default_preset_id: null }),
  ]);
});

test("POST /api/reviews lance un scan headless et l'expose par review et projet", async () => {
  if (!current) throw new Error("serveur de test non démarré");
  const repo = mkdtempSync(join(tmpdir(), "pupitre-review-api-"));
  const runGit = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: repo });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  };
  runGit("init", "-q");
  runGit("config", "user.email", "api@example.test");
  runGit("config", "user.name", "API Fixture");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src/value.ts"), "export const value = 1\n");
  runGit("add", ".");
  runGit("commit", "-qm", "base");
  writeFileSync(join(repo, "src/value.ts"), "export const value = 2\n");
  runGit("add", ".");
  runGit("commit", "-qm", "head");

  const project = await createProject(repo);
  const preset = await postJson("/api/presets", {
    name: "Revue projet",
    provider: "codex",
    model: "gpt-5.6-luna",
    effort: "high",
    speed: "standard",
    orchestrator: true,
    review_provider: "codex",
    review_model: "gpt-5.6-luna",
    review_effort: "medium",
  });
  expect(preset.status).toBe(201);
  const { id: presetId } = await preset.json() as { id: string };
  const linked = await putJson(`/api/projects/${project.id}/default-review-preset`, { presetId });
  expect(linked.status).toBe(200);

  const conversation = new ConversationStore(current.db).create({
    projectId: project.id,
    provider: "codex",
    model: "gpt-5.6-luna",
    firstMessage: "change la valeur",
  });
  const started = await postJson("/api/reviews", { conversationId: conversation.id });
  expect(started.status).toBe(201);
  const created = await started.json() as { id: string; status: string };
  expect(created.status).toBe("running");
  const throttled = await postJson("/api/reviews", { conversationId: conversation.id });
  expect(throttled.status).toBe(429);
  expect(await throttled.json()).toEqual({ error: expect.stringMatching(/^Patientez (?:9|10) s/) });
  await current.reviews.wait(created.id);

  const detail = await fetch(`${current.baseUrl}/api/reviews/${created.id}`);
  expect(detail.status).toBe(200);
  expect(await detail.json()).toEqual(expect.objectContaining({
    id: created.id,
    project_id: project.id,
    conversation_id: conversation.id,
    status: "done",
    review_provider: "codex",
    review_model: "gpt-5.6-luna",
    review_effort: "medium",
    code_provider: "codex",
    flags: [],
  }));
  const list = await fetch(`${current.baseUrl}/api/projects/${project.id}/reviews`);
  expect(list.status).toBe(200);
  expect(await list.json()).toEqual([
    expect.objectContaining({ id: created.id, status: "done" }),
  ]);
});

test("un corps avec reviewModel est refusé 400", async () => {
  if (!current) throw new Error("serveur de test non démarré");
  const project = await createProject(tmpdir());
  const conversation = new ConversationStore(current.db).create({
    projectId: project.id, provider: "codex", model: "gpt-5.6-luna", firstMessage: "x",
  });
  const rejected = await postJson("/api/reviews", {
    conversationId: conversation.id,
    reviewModel: "gpt-5.6-sol",
  });
  expect(rejected.status).toBe(400);
});

test("dispatch utilise le preset de correction du projet", async () => {
  if (!current) throw new Error("serveur de test non démarré");
  const project = await createProject(tmpdir());
  const preset = await postJson("/api/presets", {
    name: "Correction projet",
    provider: "claude",
    model: "opus",
    effort: "high",
    speed: null,
    orchestrator: true,
  });
  expect(preset.status).toBe(201);
  const { id: presetId } = await preset.json() as { id: string };
  const linked = await putJson(`/api/projects/${project.id}/default-correction-preset`, { presetId });
  expect(linked.status).toBe(200);

  const conversation = new ConversationStore(current.db).create({
    projectId: project.id, provider: "codex", model: "gpt-5.6-luna", firstMessage: "risque",
  });
  const reviewStore = new ReviewStore(current.db);
  const review = reviewStore.create({
    projectId: project.id, conversationId: conversation.id, gitRefBase: "base", gitRefHead: "head",
    provider: "codex", model: "gpt-5.6-sol", effort: "high",
  });
  reviewStore.complete(review.id, [{
    file: "src/danger.ts", line_start: 4, line_end: 4, severity: "red",
    category: "perte de données", message: "La suppression doit conserver une sauvegarde.",
  }]);
  const flag = reviewStore.get(review.id)!.flags[0]!;

  const dispatched = await postJson(`/api/review-flags/${flag.id}/dispatch`, {});
  expect(dispatched.status).toBe(201);
  const { subtaskId } = await dispatched.json() as { subtaskId: string };
  expect(current.subtasks.get(subtaskId)).toMatchObject({
    provider: "claude",
    model: "opus",
  });
  await current.subtasks.waitResult(subtaskId);
  // La fin de la correction relance une review incrémentale (tâche 3) : sans
  // l'attendre, son exécution continue en tâche de fond après la fermeture
  // de la base par `afterEach` et casse le test suivant.
  const rescan = current.reviews.listByProject(project.id).find((item) => item.id !== review.id);
  if (rescan) await current.reviews.wait(rescan.id);
});

test("un flag est traité directement sans décision groupée", async () => {
  if (!current) throw new Error("serveur de test non démarré");
  const project = await createProject(tmpdir());
  const conversation = new ConversationStore(current.db).create({
    projectId: project.id,
    provider: "codex",
    model: "gpt-5.6-luna",
    firstMessage: "risque",
  });
  const reviewStore = new ReviewStore(current.db);
  const review = reviewStore.create({
    projectId: project.id,
    conversationId: conversation.id,
    gitRefBase: "base",
    gitRefHead: "head",
    provider: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
  });
  reviewStore.complete(review.id, [{
    file: "src/danger.ts",
    line_start: 12,
    line_end: 12,
    severity: "red",
    category: "perte de données",
    message: "Conserve une sauvegarde avant la suppression.",
  }]);
  const storedReview = reviewStore.get(review.id)!;
  const flag = storedReview.flags[0]!;
  const invalidStatus = await fetch(`${current.baseUrl}/api/review-flags/${flag.id}`, {
    method: "PATCH",
    headers: jsonHeaders(),
    body: JSON.stringify({ status: "invalide" }),
  });
  expect(invalidStatus.status).toBe(400);
  const noStatus = await fetch(`${current.baseUrl}/api/review-flags/${flag.id}`, {
    method: "PATCH",
    headers: jsonHeaders(),
    body: JSON.stringify({}),
  });
  expect(noStatus.status).toBe(400);
  expect(reviewStore.getFlag(flag.id)).toMatchObject({
    status: "open",
    code_provider: "codex",
  });

  const treated = await fetch(`${current.baseUrl}/api/review-flags/${flag.id}`, {
    method: "PATCH",
    headers: jsonHeaders(),
    body: JSON.stringify({ status: "treated" }),
  });
  expect(treated.status).toBe(200);
  expect(await treated.json()).toEqual(expect.objectContaining({ id: flag.id, status: "treated" }));
});

test("la création d'un preset invalide conserve son erreur de validation", async () => {
  const response = await postJson("/api/presets", {
    name: "Invalide",
    provider: "claude",
    model: "fable-5",
    speed: "fast",
  });

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "vitesse fast indisponible pour claude" });
});

test("persiste les seuils de quota dans settings", async () => {
  if (!current) throw new Error("serveur de test non démarré");
  const emptySettings = await fetch(`${current.baseUrl}/api/settings`);
  // `conductorToolTokens` est calculé en lecture, pas un réglage persisté.
  expect(await emptySettings.json()).toMatchObject({ conductorToolTokens: expect.any(Number) });

  const saved = await putJson("/api/settings", {
    quotaThresholds: { lastHour: false, usedPercent: 91 },
  });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual({
    quotaThresholds: { lastHour: false, usedPercent: 91 },
  });

  const longTask = await putJson("/api/settings", {
    longTaskThresholdSeconds: 45,
  });
  expect(await longTask.json()).toEqual({
    longTaskThresholdSeconds: 45,
    quotaThresholds: { lastHour: false, usedPercent: 91 },
  });

  const invalid = await putJson("/api/settings", {
    quotaThresholds: { lastHour: true, usedPercent: 101 },
  });
  expect(invalid.status).toBe(400);

  const globalFilesystem = await putJson("/api/settings", {
    filesystemScope: "full-system",
  });
  expect(await globalFilesystem.json()).toEqual({
    filesystemScope: "full-system",
    longTaskThresholdSeconds: 45,
    quotaThresholds: { lastHour: false, usedPercent: 91 },
  });
  const inheritedProject = await createProject(tmpdir());
  expect(inheritedProject).toEqual(expect.objectContaining({
    filesystem_scope: "full-system",
  }));

  await putJson("/api/settings", { filesystemScope: "project-and-ai-roots" });
});

test("CRUD et exécution immédiate d'une routine avec notification", async () => {
  if (!current) throw new Error("serveur de test non démarré");
  const project = await createProject(tmpdir());
  const created = await postJson("/api/routines", {
    projectId: project.id,
    name: "Routine API",
    schedule: "* * * * *",
    workflowId: null,
    prompt: "Exécute la routine.",
    presetId: null,
    provider: "claude",
    model: "haiku",
    effort: "low",
    speed: null,
    orchestrator: false,
    enabled: true,
  });
  expect(created.status).toBe(201);
  const routine = await created.json() as { id: string };
  const list = await fetch(`${current.baseUrl}/api/routines?projectId=${project.id}`);
  expect(await list.json()).toEqual([
    expect.objectContaining({ id: routine.id, next_run_at: expect.any(String) }),
  ]);

  const run = await postJson(`/api/routines/${routine.id}/run`, {});
  expect(run.status).toBe(201);
  const startedRun = await run.json() as { conversation_id: string; status: string };
  expect(startedRun).toMatchObject({ status: "running", conversation_id: expect.any(String) });
  await waitForRunnerIdle(startedRun.conversation_id);
  await Bun.sleep(20);
  const notifications = await fetch(`${current.baseUrl}/api/notifications?after=0`);
  expect(await notifications.json()).toEqual([
    expect.objectContaining({ kind: "routine", conversation_id: expect.any(String) }),
  ]);
  const cursor = await fetch(`${current.baseUrl}/api/notifications/cursor`);
  expect(await cursor.json()).toEqual({ cursor: 1 });
});

test("Fleet expose et diffuse les runs actifs", async () => {
  if (!current) throw new Error("serveur de test non démarré");
  const project = await createProject(tmpdir());
  const conversations = new ConversationStore(current.db);
  const conversation = conversations.create({
    projectId: project.id,
    provider: "claude",
    model: "haiku",
    firstMessage: "BLOQUE Fleet",
  });
  const run = current.runner.runTurn(conversation.id, "BLOQUE Fleet", []);

  const response = await fetch(`${current.baseUrl}/api/fleet`);
  expect(await response.json()).toEqual([
    expect.objectContaining({ kind: "turn", conversationId: conversation.id }),
  ]);

  const snapshot = await new Promise<Array<{ conversationId: string }>>((resolve, reject) => {
    const socket = new WebSocket(`${current!.baseUrl.replace("http", "ws")}/ws?channel=fleet`);
    const timeout = setTimeout(() => reject(new Error("timeout Fleet WS")), 2_000);
    socket.addEventListener("message", (message) => {
      clearTimeout(timeout);
      socket.close();
      resolve(JSON.parse(String(message.data)));
    });
    socket.addEventListener("error", reject);
  });
  expect(snapshot).toEqual([
    expect.objectContaining({ conversationId: conversation.id, lastEvent: expect.any(String) }),
  ]);

  expect(await current.runner.cancelTurn(conversation.id)).toBe(true);
  await run;
});

test("le push review-status est scindé par projectId et l'ancien mode Gardien n'existe plus", async () => {
  if (!current) throw new Error("serveur de test non démarré");
  const project = await createProject(tmpdir());
  const conversation = new ConversationStore(current.db).create({
    projectId: project.id, provider: "codex", model: "gpt-5.6-luna", firstMessage: "x",
  });
  const store = new ReviewStore(current.db);
  const review = store.create({
    projectId: project.id, conversationId: conversation.id, gitRefBase: "base", gitRefHead: "head",
    provider: "codex", model: "gpt-5.6-sol", effort: "high",
  });
  store.complete(review.id, [{
    file: "src/risk.ts", line_start: 1, line_end: 1, severity: "red",
    category: "données", message: "Préserve la sauvegarde.",
  }]);
  const flag = store.get(review.id)!.flags[0]!;

  const route = await fetch(`${current.baseUrl}/api/projects/${project.id}/review-status`);
  expect(await route.json()).toEqual({
    openBySeverity: { red: 1, orange: 0, grey: 0 }, running: null,
  });
  expect((await putJson(`/api/projects/${project.id}/gardien-mode`, { mode: "bloquant" })).status).toBe(404);

  const pushed = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const socket = new WebSocket(`${current!.baseUrl.replace("http", "ws")}/ws?channel=fleet`);
    const timeout = setTimeout(() => { socket.close(); reject(new Error("timeout review-status WS")); }, 2_000);
    socket.addEventListener("open", () => {
      current!.reviews.updateFlag(flag.id, { status: "treated" });
    });
    socket.addEventListener("message", (message) => {
      const payload = JSON.parse(String(message.data)) as Record<string, unknown>;
      if (payload.projectId !== project.id) return;
      clearTimeout(timeout);
      socket.close();
      resolve(payload);
    });
    socket.addEventListener("error", reject);
  });
  expect(pushed).toEqual({
    projectId: project.id,
    openBySeverity: { red: 0, orange: 0, grey: 0 },
    running: null,
  });
});

test("recherche les titres et messages par projet", async () => {
  if (!current) throw new Error("serveur de test non démarré");
  const project = await createProject(tmpdir());
  const conversations = new ConversationStore(current.db);
  const conversation = conversations.create({
    projectId: project.id,
    provider: "codex",
    model: "gpt-5.6-luna",
    firstMessage: "Diagnostic volcanique",
  });
  conversations.appendEvent(conversation.id, {
    type: "text-final",
    text: "Le basalte confirme l'hypothèse.",
  });

  const response = await fetch(
    `${current.baseUrl}/api/search?q=basalte&projectId=${project.id}`,
  );
  expect(await response.json()).toEqual([
    expect.objectContaining({ kind: "event", conversationId: conversation.id }),
  ]);
});

test("rejette les Origin distants et accepte localhost, Tauri ou l'absence d'Origin", async () => {
  if (!current) throw new Error("serveur de test non démarré");
  const evil = await fetch(`${current.baseUrl}/api/health`, {
    headers: { Origin: "https://evil.com" },
  });
  expect(evil.status).toBe(403);

  const localhost = await fetch(`${current.baseUrl}/api/health`, {
    headers: { Origin: "http://localhost:5173" },
  });
  expect(localhost.status).toBe(200);

  const tauri = await fetch(`${current.baseUrl}/api/health`, {
    headers: { Origin: "tauri://localhost" },
  });
  expect(tauri.status).toBe(200);
  expect(tauri.headers.get("access-control-allow-origin")).toBe("tauri://localhost");

  const preflight = await fetch(`${current.baseUrl}/api/conversations`, {
    method: "OPTIONS",
    headers: {
      Origin: "tauri://localhost",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("access-control-allow-methods")).toContain("POST");

  const noOrigin = await fetch(`${current.baseUrl}/api/health`);
  expect(noOrigin.status).toBe(200);
});

test("une conversation termine en live via WS et son replay commence par user-message", async () => {
  if (!current) throw new Error("serveur de test non démarré");
  const project = await createProject(tmpdir());
  const created = await postJson("/api/conversations", {
    projectId: project.id,
    provider: "claude",
    model: "haiku",
    message: "ATTENDS_WS",
  });
  expect(created.status).toBe(201);
  const conversation = await created.json() as { id: string };

  const wsUrl = `${current.baseUrl.replace("http", "ws")}/ws?conversation=${conversation.id}`;
  const waiter = webSocketEventWaiter(
    wsUrl,
    (event) => event.type === "status" && event.state === "done",
  );
  const done = await waiter.event;
  expect(done).toMatchObject({ type: "status", state: "done" });

  const replay = await fetch(
    `${current.baseUrl}/api/conversations/${conversation.id}/events`,
  );
  expect(replay.status).toBe(200);
  const stored = await replay.json() as StoredEvent[];
  expect(stored.length).toBeGreaterThan(1);
  expect(stored[0]).toMatchObject({
    type: "user-message",
    text: "ATTENDS_WS",
    images: [],
  });

  const conversations = await fetch(
    `${current.baseUrl}/api/projects/${project.id}/conversations`,
  );
  expect(await conversations.json()).toEqual([
    expect.objectContaining({ id: conversation.id, project_id: project.id }),
  ]);
  expect((await postJson(`/api/projects/${project.id}/pin`, { pinned: true })).status)
    .toBe(204);
  expect((await postJson(`/api/conversations/${conversation.id}/pin`, { pinned: true })).status)
    .toBe(204);
});

test("les événements WS gardent des ids croissants après compaction du replay", async () => {
  if (!current) throw new Error("serveur de test non démarré");
  const project = await createProject(tmpdir());
  const created = await postJson("/api/conversations", {
    projectId: project.id,
    provider: "claude",
    model: "haiku",
    message: "ATTENDS_WS",
  });
  const conversation = await created.json() as { id: string };

  const wsUrl = `${current.baseUrl.replace("http", "ws")}/ws?conversation=${conversation.id}`;
  const live = await collectWebSocketEvents(
    wsUrl,
    (event) => event.type === "status" && event.state === "done",
  );

  const replay = await fetch(
    `${current.baseUrl}/api/conversations/${conversation.id}/events`,
  );
  const stored = await replay.json() as StoredEvent[];

  expect(live.length).toBeGreaterThan(0);
  for (const [index, event] of live.entries()) {
    expect(typeof event.id).toBe("number");
    if (index > 0) expect(event.id).toBeGreaterThan(live[index - 1]!.id);
    // Les text-delta restent fins en WS puis sont compactés en DB après le tour.
    // Tous les autres événements conservent leur ligne et leur id à l'identique.
    if (event.type !== "text-delta") {
      expect(stored.find((candidate) => candidate.id === event.id)).toEqual(event);
    }
  }
  const storedIds = stored.map((event) => event.id);
  expect(storedIds).toEqual([...storedIds].sort((a, b) => a - b));
});

test("création avec effort le persiste et l'expose dans les listes", async () => {
  if (!current) throw new Error("serveur de test non démarré");
  const project = await createProject(tmpdir());
  const created = await postJson("/api/conversations", {
    projectId: project.id,
    provider: "claude",
    model: "haiku",
    effort: "xhigh",
    message: "effort persisté",
  });

  expect(created.status).toBe(201);
  const conversation = await created.json() as { id: string; effort: string | null };
  expect(conversation.effort).toBe("xhigh");
  await waitForRunnerIdle(conversation.id);

  const response = await fetch(
    `${current.baseUrl}/api/projects/${project.id}/conversations`,
  );
  expect(await response.json()).toEqual([
    expect.objectContaining({ id: conversation.id, effort: "xhigh" }),
  ]);
});

test("rejette avec 400 les efforts invalides pour chaque provider", async () => {
  const project = await createProject(tmpdir());
  const invalidClaude = await postJson("/api/conversations", {
    projectId: project.id,
    provider: "claude",
    model: "haiku",
    effort: "ultra",
    message: "invalide claude",
  });
  const invalidCodex = await postJson("/api/conversations", {
    projectId: project.id,
    provider: "codex",
    model: "gpt-5.6-sol",
    effort: "max",
    message: "invalide codex",
  });

  expect(invalidClaude.status).toBe(400);
  expect(invalidCodex.status).toBe(400);
});

test("création Codex avec vitesse fast la persiste et l'expose", async () => {
  if (!current) throw new Error("serveur de test non démarré");
  const project = await createProject(tmpdir());
  const standard = await postJson("/api/conversations", {
    projectId: project.id,
    provider: "codex",
    model: "gpt-5.6-sol",
    speed: "standard",
    message: "réponse standard",
  });
  expect(standard.status).toBe(201);
  const standardConversation = await standard.json() as {
    id: string;
    speed: string | null;
  };
  expect(standardConversation.speed).toBe("standard");
  await waitForRunnerIdle(standardConversation.id);

  const created = await postJson("/api/conversations", {
    projectId: project.id,
    provider: "codex",
    model: "gpt-5.6-sol",
    speed: "fast",
    message: "réponse rapide",
  });

  expect(created.status).toBe(201);
  const conversation = await created.json() as { id: string; speed: string | null };
  expect(conversation.speed).toBe("fast");
  await waitForRunnerIdle(conversation.id);

  const response = await fetch(
    `${current.baseUrl}/api/projects/${project.id}/conversations`,
  );
  expect(await response.json()).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: conversation.id, speed: "fast" }),
    expect.objectContaining({ id: standardConversation.id, speed: "standard" }),
  ]));
});

test("rejette avec 400 une vitesse invalide et fast pour Claude", async () => {
  const project = await createProject(tmpdir());
  const invalidSpeed = await postJson("/api/conversations", {
    projectId: project.id,
    provider: "codex",
    model: "gpt-5.6-sol",
    speed: "turbo",
    message: "vitesse invalide",
  });
  const fastClaude = await postJson("/api/conversations", {
    projectId: project.id,
    provider: "claude",
    model: "haiku",
    speed: "fast",
    message: "fast indisponible",
  });

  expect(invalidSpeed.status).toBe(400);
  expect(fastClaude.status).toBe(400);
});

test("change de modèle dans le même provider et le tour suivant l'utilise", async () => {
  if (!current) throw new Error("serveur de test non démarré");
  const project = await createProject(tmpdir());
  const created = await postJson("/api/conversations", {
    projectId: project.id,
    provider: "claude",
    model: "haiku",
    effort: "low",
    message: "premier tour",
  });
  const conversation = await created.json() as { id: string };
  await waitForRunnerIdle(conversation.id);

  const argsFile = join(tmpdir(), `pupitre-switch-${crypto.randomUUID()}`);
  process.env.FAKE_CLAUDE_ARGS_FILE = argsFile;
  const switched = await putJson(`/api/conversations/${conversation.id}/model`, {
    provider: "claude",
    model: "sonnet",
    effort: "high",
    speed: null,
  });
  expect(switched.status).toBe(200);
  expect(await switched.json()).toEqual({
    conversation: expect.objectContaining({ model: "sonnet", effort: "high" }),
    estimatedReingestionTokens: expect.any(Number),
  });

  expect((await postJson(`/api/conversations/${conversation.id}/messages`, {
    message: "après switch",
  })).status).toBe(202);
  await waitForRunnerIdle(conversation.id);
  expect(readFileSync(argsFile, "utf8")).toContain("--model sonnet");
});

test("handoff cross-provider résume, crée et seed une conversation liée", async () => {
  if (!current) throw new Error("serveur de test non démarré");
  process.env.PUPITRE_CODEX_MODE = "exec";
  const project = await createProject(tmpdir());
  const created = await postJson("/api/conversations", {
    projectId: project.id,
    provider: "claude",
    model: "haiku",
    message: "construis la feature",
  });
  const source = await created.json() as { id: string };
  await waitForRunnerIdle(source.id);

  const response = await postJson(`/api/conversations/${source.id}/handoff`, {
    provider: "codex",
    model: "gpt-5.6-luna",
    effort: "low",
    speed: "fast",
    orchestrator: true,
  });
  expect(response.status).toBe(201);
  const continuation = await response.json() as {
    id: string;
    continued_from: string;
    provider: string;
    handoff_pending: boolean;
  };
  expect(continuation).toMatchObject({
    continued_from: source.id,
    provider: "codex",
    handoff_pending: false,
  });

  const events = await fetch(
    `${current.baseUrl}/api/conversations/${continuation.id}/events`,
  ).then((result) => result.json()) as StoredEvent[];
  expect(events[0]).toMatchObject({
    type: "user-message",
    text: expect.stringContaining("## Décisions et pourquoi"),
  });
  expect(events.at(-1)).toMatchObject({ type: "status", state: "done" });

  const sourceEvents = await fetch(
    `${current.baseUrl}/api/conversations/${source.id}/events`,
  ).then((result) => result.json()) as StoredEvent[];
  expect(sourceEvents.at(-1)).toMatchObject({ type: "debrief-ref" });

  const list = await fetch(
    `${current.baseUrl}/api/projects/${project.id}/conversations`,
  ).then((result) => result.json()) as Array<{ id: string; continued_from: string | null }>;
  expect(list).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: continuation.id, continued_from: source.id }),
  ]));
});

test("un handoff dont le provider cible échoue ne conserve pas de continuation", async () => {
  if (!current) throw new Error("serveur de test non démarré");
  const project = await createProject(tmpdir());
  const created = await postJson("/api/conversations", {
    projectId: project.id,
    provider: "claude",
    model: "haiku",
    message: "source stable",
  });
  const source = await created.json() as { id: string };
  await waitForRunnerIdle(source.id);
  process.env.PUPITRE_CODEX_MODE = "exec";
  process.env.PUPITRE_CODEX_BIN = join(tmpdir(), `codex-absent-${crypto.randomUUID()}`);
  let cancelledContinuationId: string | null = null;
  const cancelByConversation = current.subtasks.cancelByConversation.bind(current.subtasks);
  current.subtasks.cancelByConversation = async (conversationId) => {
    cancelledContinuationId = conversationId;
    return cancelByConversation(conversationId);
  };

  const response = await postJson(`/api/conversations/${source.id}/handoff`, {
    provider: "codex",
    model: "gpt-5.6-luna",
    effort: "low",
  });

  expect(response.status).toBe(502);
  expect(cancelledContinuationId).not.toBeNull();
  expect(cancelledContinuationId).not.toBe(source.id);
  expect(new ConversationStore(current.db).listByProject(project.id)).toEqual([
    expect.objectContaining({ id: source.id }),
  ]);
});

test("une continuation en cours de nettoyage refuse un nouveau message", async () => {
  if (!current) throw new Error("serveur de test non démarré");
  const project = await createProject(tmpdir());
  const created = await postJson("/api/conversations", {
    projectId: project.id,
    provider: "claude",
    model: "haiku",
    message: "source stable",
  });
  const source = await created.json() as { id: string };
  await waitForRunnerIdle(source.id);
  process.env.PUPITRE_CODEX_MODE = "exec";
  process.env.PUPITRE_CODEX_BIN = join(tmpdir(), `codex-absent-${crypto.randomUUID()}`);
  // Le nettoyage d'une continuation ratée relâche le verrou d'activité avant de
  // supprimer la ligne : on tire dans cette fenêtre exacte.
  let concurrentStatus = 0;
  const cancelByConversation = current.subtasks.cancelByConversation.bind(current.subtasks);
  current.subtasks.cancelByConversation = async (conversationId) => {
    const concurrent = await postJson(`/api/conversations/${conversationId}/messages`, {
      message: "message envoyé pendant le nettoyage",
    });
    concurrentStatus = concurrent.status;
    return cancelByConversation(conversationId);
  };

  const response = await postJson(`/api/conversations/${source.id}/handoff`, {
    provider: "codex",
    model: "gpt-5.6-luna",
    effort: "low",
  });

  expect(response.status).toBe(502);
  expect(concurrentStatus).toBe(409);
  expect(new ConversationStore(current.db).listByProject(project.id)).toEqual([
    expect.objectContaining({ id: source.id }),
  ]);
});

test("POST debrief versionne le bilan, le diffuse et l'expose en lecture", async () => {
  if (!current) throw new Error("serveur de test non démarré");
  const project = await createProject(tmpdir());
  const created = await postJson("/api/conversations", {
    projectId: project.id,
    provider: "claude",
    model: "sonnet",
    effort: "high",
    orchestrator: true,
    message: "Décidons de rester local-first",
    images: [],
  });
  expect(created.status).toBe(201);
  const conversation = await created.json() as { id: string };
  await waitForRunnerIdle(conversation.id);
  const wsWaiter = webSocketEventWaiter(
    `ws://127.0.0.1:${current.server.port}/ws?conversation=${conversation.id}`,
    (event) => event.type === "debrief-ref",
  );
  await wsWaiter.opened;

  const response = await postJson(`/api/conversations/${conversation.id}/debrief`, {});

  expect(response.status).toBe(201);
  const debrief = await response.json() as { id: string; content_md: string };
  expect(debrief.content_md).toContain("## Décisions et pourquoi");
  expect(await wsWaiter.event).toEqual(expect.objectContaining({
    type: "debrief-ref",
    debriefId: debrief.id,
  }));
  const versions = await fetch(
    `${current.baseUrl}/api/conversations/${conversation.id}/debriefs`,
  );
  expect(await versions.json()).toEqual([expect.objectContaining({ id: debrief.id })]);
  const detail = await fetch(`${current.baseUrl}/api/debriefs/${debrief.id}`);
  expect(await detail.json()).toEqual(expect.objectContaining({ id: debrief.id }));

  const duplicate = await postJson(`/api/conversations/${conversation.id}/debrief`, {});
  expect(duplicate.status).toBe(409);
});

test("Résumé session reste court et le handoff expose un document réutilisable", async () => {
  if (!current) throw new Error("serveur de test non démarré");
  const project = await createProject(tmpdir());
  const created = await postJson("/api/conversations", {
    projectId: project.id,
    provider: "claude",
    model: "sonnet",
    effort: "high",
    orchestrator: true,
    message: "Implémentons le parcours de passation",
    images: [],
  });
  const conversation = await created.json() as { id: string };
  await waitForRunnerIdle(conversation.id);

  const summaryResponse = await postJson(
    `/api/conversations/${conversation.id}/session-summary`,
    {},
  );
  expect(summaryResponse.status).toBe(201);
  const summary = await summaryResponse.json() as { content_md: string };
  expect(summary.content_md).toContain("## Implémenté");
  expect(summary.content_md).not.toContain("## Décisions et pourquoi");

  const documentResponse = await postJson(
    `/api/conversations/${conversation.id}/handoff-document`,
    {},
  );
  expect(documentResponse.status).toBe(201);
  const document = await documentResponse.json() as {
    filename: string;
    contentMd: string;
  };
  expect(document.filename).toMatch(/^handoff-/);
  expect(document.contentMd).toContain("# Handoff");
  expect(document.contentMd).toContain("## Débrief de passation");

  const continuationResponse = await postJson(
    `/api/conversations/${conversation.id}/handoff-conversation`,
    {
      provider: "claude",
      model: "sonnet",
      effort: "high",
      speed: null,
      orchestrator: true,
    },
  );
  expect(continuationResponse.status).toBe(201);
  expect(await continuationResponse.json()).toEqual(expect.objectContaining({
    continued_from: conversation.id,
    handoff_pending: false,
  }));
});

test("Tester inventorie les scopes puis exécute le choix avec un résultat inline", async () => {
  if (!current) throw new Error("serveur de test non démarré");
  const project = await createProject(tmpdir());
  const created = await postJson("/api/conversations", {
    projectId: project.id,
    provider: "claude",
    model: "haiku",
    message: "implémente un endpoint",
  });
  const conversation = await created.json() as { id: string };
  await waitForRunnerIdle(conversation.id);

  const inventoryResponse = await postJson(
    `/api/conversations/${conversation.id}/test-inventory`,
    {},
  );
  expect(inventoryResponse.status).toBe(201);
  const inventory = await inventoryResponse.json() as {
    id: string;
    scopes: Array<{ id: string; status: string }>;
  };
  expect(inventory.scopes).toEqual([
    expect.objectContaining({ status: "pending" }),
  ]);

  const fetched = await fetch(`${current.baseUrl}/api/test-inventories/${inventory.id}`);
  expect(fetched.status).toBe(200);
  const started = await postJson(`/api/test-scopes/${inventory.scopes[0]!.id}/run`, {});
  expect(started.status).toBe(202);
  expect(await started.json()).toMatchObject({ status: "running" });

  expect(await waitForPersistedEvent(
    conversation.id,
    (event) => event.type === "test-scope-result",
  )).toMatchObject({
    type: "test-scope-result",
    status: "failed",
    evidenceMd: expect.stringContaining("Preuves"),
  });
});

test("un tour Claude actif accepte une précision, puis cancel le déverrouille", async () => {
  if (!current) throw new Error("serveur de test non démarré");
  const project = await createProject(tmpdir());
  const created = await postJson("/api/conversations", {
    projectId: project.id,
    provider: "claude",
    model: "haiku",
    message: "BLOQUE",
  });
  expect(created.status).toBe(201);
  const conversation = await created.json() as { id: string };

  const steered = await postJson(
    `/api/conversations/${conversation.id}/messages`,
    { message: "deuxième" },
  );
  expect(steered.status).toBe(202);
  expect(await steered.json()).toEqual({ delivery: "steered" });

  const cancelled = await postJson(
    `/api/conversations/${conversation.id}/cancel`,
    {},
  );
  expect(cancelled.status).toBe(202);

  const replay = await fetch(
    `${current.baseUrl}/api/conversations/${conversation.id}/events`,
  );
  const events = await replay.json() as StoredEvent[];
  expect(events.at(-1)).toMatchObject({
    type: "status",
    state: "error",
    error: "annulé",
  });

  const wsUrl = `${current.baseUrl.replace("http", "ws")}/ws?conversation=${conversation.id}`;
  const unlockedWaiter = webSocketEventWaiter(
    wsUrl,
    (event) => event.type === "status" && event.state === "done",
  );
  await unlockedWaiter.opened;
  const next = await postJson(
    `/api/conversations/${conversation.id}/messages`,
    { message: "ATTENDS_WS après annulation" },
  );
  expect(next.status).toBe(202);
  await unlockedWaiter.event;
});

test("deux POST Claude quasi simultanés démarrent puis orientent le même tour", async () => {
  if (!current) throw new Error("serveur de test non démarré");
  const project = await createProject(tmpdir());
  const created = await postJson("/api/conversations", {
    projectId: project.id,
    provider: "claude",
    model: "haiku",
    message: "initial",
  });
  const conversation = await created.json() as { id: string };
  await waitForRunnerIdle(conversation.id);

  const path = `/api/conversations/${conversation.id}/messages`;
  const responses = await Promise.all([
    postJson(path, { message: "CONCURRENT_SAME premier" }),
    postJson(path, { message: "CONCURRENT_SAME second" }),
  ]);

  expect(responses.map((response) => response.status)).toEqual([202, 202]);
  expect(await Promise.all(responses.map((response) => response.json())))
    .toEqual(expect.arrayContaining([{ delivery: "started" }, { delivery: "steered" }]));
  await waitForRunnerIdle(conversation.id);
});

test("un Origin distant est aussi refusé pendant l'upgrade WebSocket", async () => {
  if (!current) throw new Error("serveur de test non démarré");
  const project = await createProject(tmpdir());
  const created = await postJson("/api/conversations", {
    projectId: project.id,
    provider: "claude",
    model: "haiku",
    message: "initial",
  });
  const conversation = await created.json() as { id: string };
  const wsUrl = `${current.baseUrl.replace("http", "ws")}/ws?conversation=${conversation.id}`;

  await new Promise<void>((resolve, reject) => {
    const BunWebSocket = WebSocket as unknown as {
      new (url: string, options: Bun.WebSocketOptions): WebSocket;
    };
    const socket = new BunWebSocket(wsUrl, {
      headers: { Origin: "https://evil.com" },
    });
    let opened = false;
    const timeout = setTimeout(() => reject(new Error("timeout WebSocket")), 3_000);
    socket.addEventListener("open", () => {
      opened = true;
      clearTimeout(timeout);
      socket.close();
      reject(new Error("upgrade WebSocket accepté"));
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.addEventListener("close", () => {
      if (opened) return;
      clearTimeout(timeout);
      resolve();
    });
  });
  await waitForRunnerIdle(conversation.id);
});

test("la déconnexion d'un client WS en plein tour n'empêche pas le status done", async () => {
  if (!current) throw new Error("serveur de test non démarré");
  const project = await createProject(tmpdir());
  const created = await postJson("/api/conversations", {
    projectId: project.id,
    provider: "claude",
    model: "haiku",
    message: "DECONNECTE_WS",
  });
  const conversation = await created.json() as { id: string };
  const wsUrl = `${current.baseUrl.replace("http", "ws")}/ws?conversation=${conversation.id}`;

  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const timeout = setTimeout(() => reject(new Error("timeout WebSocket")), 3_000);
    socket.addEventListener("open", () => socket.close());
    socket.addEventListener("close", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("erreur WebSocket"));
    });
  });

  const done = await waitForPersistedEvent(
    conversation.id,
    (event) => event.type === "status" && event.state === "done",
  );
  expect(done).toMatchObject({ type: "status", state: "done" });
  await waitForRunnerIdle(conversation.id);
});

test("upload media binaire puis GET redonne exactement les bytes", async () => {
  if (!current) throw new Error("serveur de test non démarré");
  const bytes = new Uint8Array([0, 137, 80, 78, 71, 255]);
  const upload = await fetch(`${current.baseUrl}/api/media`, {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: bytes,
  });
  expect(upload.status).toBe(201);
  const { name } = await upload.json() as { name: string };
  expect(name).toEndWith(".png");

  const download = await fetch(`${current.baseUrl}/media/${name}`);
  expect(download.status).toBe(200);
  expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);
});

test("publie, isole, conserve puis supprime un document HTML via l'API", async () => {
  if (!current) throw new Error("serveur de test non démarré");
  const projectPath = mkdtempSync(join(tmpdir(), "pupitre-html-api-project-"));
  const project = current.deps.projects.create({ name: "html-api", path: projectPath });
  const conversation = current.deps.conversations.create({
    projectId: project.id,
    provider: "claude",
    model: "haiku",
    firstMessage: "Publie le document",
  });
  const source = join(projectPath, "audit.html");
  writeFileSync(source, "<!doctype html><html><body><script>document.body.dataset.ready='1'</script>Audit</body></html>");
  const ws = webSocketEventWaiter(
    `${current.baseUrl.replace("http", "ws")}/ws?conversation=${conversation.id}`,
    (event) => event.type === "html-document-ref",
  );
  await ws.opened;

  const publishedResponse = await postJson(
    `/api/conversations/${conversation.id}/html-documents`,
    { path: source, title: "Audit HTML", summary: "Validation", deleteSource: true },
  );
  expect(publishedResponse.status).toBe(201);
  const published = await publishedResponse.json() as { id: string; state: string };
  expect(published.state).toBe("retained");
  expect(existsSync(source)).toBe(true);
  expect(await ws.event).toMatchObject({
    type: "html-document-ref",
    documentId: published.id,
    title: "Audit HTML",
  });

  const invalid = await fetch(
    `${current.baseUrl}/api/html-documents/${published.id}/content?token=invalide`,
  );
  expect(invalid.status).toBe(403);

  const grantResponse = await postJson(
    `/api/html-documents/${published.id}/view-token`,
    {},
  );
  expect(grantResponse.status).toBe(201);
  const grant = await grantResponse.json() as { token: string };
  const content = await fetch(
    `${current.baseUrl}/api/html-documents/${published.id}/content?token=${grant.token}`,
  );
  expect(content.status).toBe(200);
  expect(content.headers.get("content-type")).toContain("text/html");
  expect(content.headers.get("content-security-policy")).toContain("connect-src 'none'");
  expect(content.headers.get("content-security-policy")).toContain(
    "sandbox allow-scripts allow-modals",
  );
  expect(await content.text()).toContain("dataset.ready");

  const search = await fetch(`${current.baseUrl}/api/documents?q=Audit`);
  expect(await search.json()).toEqual([
    expect.objectContaining({ id: published.id, matchCount: expect.any(Number) }),
  ]);

  const thumbnail = await fetch(`${current.baseUrl}/api/documents/${published.id}/thumbnail`);
  expect(thumbnail.status).toBe(200);
  expect(thumbnail.headers.get("content-type")).toMatch(/^image\/(png|svg\+xml)$/);
  expect((await thumbnail.arrayBuffer()).byteLength).toBeGreaterThan(100);

  const exportedPath = join(projectPath, "audit-export.html");
  const exported = await postJson(`/api/documents/${published.id}/export`, {
    path: exportedPath,
  });
  expect(exported.status).toBe(200);
  expect(readFileSync(exportedPath, "utf8")).toContain("dataset.ready");

  const trashed = await postJson(`/api/conversations/${conversation.id}/trash`, { deleted: true });
  expect(trashed.status).toBe(200);
  const afterConversationTrash = await fetch(`${current.baseUrl}/api/documents/${published.id}`);
  expect(afterConversationTrash.status).toBe(200);

  const retained = await postJson(`/api/html-documents/${published.id}/retain`, {});
  expect(await retained.json()).toMatchObject({ state: "retained", expiresAt: null });
  const removed = await fetch(`${current.baseUrl}/api/html-documents/${published.id}`, {
    method: "DELETE",
  });
  expect(await removed.json()).toMatchObject({ state: "deleted" });

  const afterDelete = await postJson(`/api/html-documents/${published.id}/view-token`, {});
  expect(afterDelete.status).toBe(410);
});

test("refuse avec 413 une image qui dépasse la taille maximale", async () => {
  if (!current) throw new Error("serveur de test non démarré");
  process.env.PUPITRE_MEDIA_MAX_BYTES = "5";
  try {
    const upload = await fetch(`${current.baseUrl}/api/media`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: new Uint8Array([0, 1, 2, 3, 4, 5]),
    });
    expect(upload.status).toBe(413);
  } finally {
    delete process.env.PUPITRE_MEDIA_MAX_BYTES;
  }
});

test("refuse avec 413 un message dont les images dépassent le total autorisé", async () => {
  if (!current) throw new Error("serveur de test non démarré");
  process.env.PUPITRE_MEDIA_MAX_BYTES = "5";
  process.env.PUPITRE_MESSAGE_MEDIA_MAX_BYTES = "8";
  try {
    const upload = async (bytes: Uint8Array<ArrayBuffer>) => {
      const response = await fetch(`${current!.baseUrl}/api/media`, {
        method: "POST",
        headers: { "content-type": "image/png" },
        body: bytes,
      });
      expect(response.status).toBe(201);
      return (await response.json() as { name: string }).name;
    };
    const first = await upload(new Uint8Array([0, 1, 2, 3, 4]));
    const second = await upload(new Uint8Array([5, 6, 7, 8, 9]));
    const project = await createProject(tmpdir());

    const created = await postJson("/api/conversations", {
      projectId: project.id,
      provider: "claude",
      model: "haiku",
      message: "trop d'images",
      images: [first, second],
    });
    expect(created.status).toBe(413);
  } finally {
    delete process.env.PUPITRE_MEDIA_MAX_BYTES;
    delete process.env.PUPITRE_MESSAGE_MEDIA_MAX_BYTES;
  }
});

test("GET /api/quotas est vide au démarrage puis reflète le tour claude", async () => {
  if (!current) throw new Error("serveur de test non démarré");
  const empty = await fetch(`${current.baseUrl}/api/quotas`);
  expect(empty.status).toBe(200);
  expect(await empty.json()).toEqual({ claude: null, codex: null });

  const project = await createProject(tmpdir());
  const created = await postJson("/api/conversations", {
    projectId: project.id,
    provider: "claude",
    model: "haiku",
    message: "quotas",
  });
  const conversation = await created.json() as { id: string };
  await waitForPersistedEvent(
    conversation.id,
    (event) => event.type === "status" && event.state === "done",
  );
  await waitForRunnerIdle(conversation.id);

  // La fixture claude contient un rate_limit_event five_hour.
  const filled = await fetch(`${current.baseUrl}/api/quotas`);
  const snapshot = await filled.json() as {
    claude: { provider: string; windows: { label: string }[] } | null;
    codex: unknown;
  };
  expect(snapshot.codex).toBeNull();
  expect(snapshot.claude).toMatchObject({ provider: "claude" });
  expect(snapshot.claude!.windows).toEqual([
    expect.objectContaining({ label: "five_hour", windowDurationMins: 300 }),
  ]);
});

test("le canal WS quotas reçoit les mises à jour puis l'état courant à la connexion", async () => {
  if (!current) throw new Error("serveur de test non démarré");
  const quotasUrl = `ws://127.0.0.1:${current.server.port}/ws?channel=quotas`;
  const received = new Promise<any>((resolve, reject) => {
    const socket = new WebSocket(quotasUrl);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("timeout WebSocket quotas"));
    }, 5_000);
    socket.addEventListener("message", (message) => {
      clearTimeout(timeout);
      socket.close();
      resolve(JSON.parse(String(message.data)));
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("erreur WebSocket quotas"));
    });
    socket.addEventListener("open", () => {
      void (async () => {
        const project = await createProject(tmpdir());
        await postJson("/api/conversations", {
          projectId: project.id,
          provider: "claude",
          model: "haiku",
          message: "quotas WS",
        });
      })();
    });
  });
  const state = await received;
  expect(state).toMatchObject({ provider: "claude" });
  expect(state.windows[0]).toMatchObject({ label: "five_hour" });

  // Un client qui se connecte après coup reçoit immédiatement l'état connu.
  const replayed = await new Promise<any>((resolve, reject) => {
    const socket = new WebSocket(quotasUrl);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("timeout état initial quotas"));
    }, 3_000);
    socket.addEventListener("message", (message) => {
      clearTimeout(timeout);
      socket.close();
      resolve(JSON.parse(String(message.data)));
    });
  });
  expect(replayed).toEqual(state);
});

test("refuse un canal WS inconnu et exige une conversation valide sinon", async () => {
  if (!current) throw new Error("serveur de test non démarré");
  const unknownChannel = await fetch(`${current.baseUrl}/ws?channel=nimporte`);
  expect(unknownChannel.status).toBe(400);
  const missingConversation = await fetch(`${current.baseUrl}/ws`);
  expect(missingConversation.status).toBe(404);
});

test("une conversation peut naître sur sa branche, dans un worktree dédié", async () => {
  if (!current) throw new Error("serveur de test non démarré");
  const repo = mkdtempSync(join(tmpdir(), "pupitre-srv-wt-"));
  cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args: string[]): void => {
    const result = Bun.spawnSync(["git", ...args], { cwd: repo });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "git@example.test");
  git("config", "user.name", "Git Fixture");
  writeFileSync(join(repo, "README.md"), "base\n");
  git("add", "README.md");
  git("commit", "-qm", "socle");

  const project = await createProject(repo);
  const created = await postJson("/api/conversations", {
    projectId: project.id,
    provider: "claude",
    model: "haiku",
    message: "bonjour",
    branch: "ticket-7",
  });
  expect(created.status).toBe(201);
  const conversation = await created.json() as { id: string; worktree_path: string | null };

  // La conversation porte son worktree, hors du dépôt principal.
  expect(conversation.worktree_path).toBeTruthy();
  expect(conversation.worktree_path!.startsWith(repo)).toBe(false);
  expect(existsSync(conversation.worktree_path!)).toBe(true);

  // Il est listé, et protégé tant que la conversation le porte.
  const listed = await fetch(`${current.baseUrl}/api/projects/${project.id}/worktrees`);
  const payload = await listed.json() as { worktrees: Array<{ branch: string | null }> };
  expect(payload.worktrees.map((item) => item.branch)).toContain("ticket-7");

  const refused = await fetch(`${current.baseUrl}/api/projects/${project.id}/worktrees`, {
    method: "DELETE",
    headers: jsonHeaders(),
    body: JSON.stringify({ path: conversation.worktree_path }),
  });
  expect(refused.status).toBe(409);
});

test("un nom de branche qui s'évaderait du dossier géré est refusé", async () => {
  if (!current) throw new Error("serveur de test non démarré");
  const repo = mkdtempSync(join(tmpdir(), "pupitre-srv-wt-"));
  cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args: string[]): void => {
    const result = Bun.spawnSync(["git", ...args], { cwd: repo });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "git@example.test");
  git("config", "user.name", "Git Fixture");
  writeFileSync(join(repo, "README.md"), "base\n");
  git("add", "README.md");
  git("commit", "-qm", "socle");

  const project = await createProject(repo);
  const refused = await postJson("/api/conversations", {
    projectId: project.id,
    provider: "claude",
    model: "haiku",
    message: "bonjour",
    branch: "../evasion",
  });
  expect(refused.status).toBe(400);
});
