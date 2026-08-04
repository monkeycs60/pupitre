import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import type { AppEvent, StoredEvent } from "../src/events";
import { MediaStore } from "../src/media";
import { ConversationRunner } from "../src/runner";
import { ConversationEventBus, createServer } from "../src/server";
import { ConversationStore } from "../src/stores/conversations";
import { ProjectStore } from "../src/stores/projects";
import { PresetStore } from "../src/stores/presets";
import { SettingsStore } from "../src/stores/settings";
import { QuotaTracker } from "../src/quotas";
import { SubtaskRunner } from "../src/subtasks";
import { ReviewStore } from "../src/stores/reviews";
import { ReviewRunner } from "../src/reviews";

interface TestServer {
  baseUrl: string;
  db: Database;
  runner: ConversationRunner;
  server: ReturnType<typeof createServer>;
  reviews: ReviewRunner;
}

let current: TestServer | undefined;
let previousClaudeBin: string | undefined;
let previousCodexBin: string | undefined;

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

function waitForWebSocketEvent(
  url: string,
  predicate: (event: AppEvent) => boolean,
): Promise<StoredEvent> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("timeout WebSocket"));
    }, 3_000);

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
case "$*" in
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
  previousClaudeBin = process.env.PUPITRE_CLAUDE_BIN;
  previousCodexBin = process.env.PUPITRE_CODEX_BIN;
  process.env.PUPITRE_CLAUDE_BIN = fakeClaude;
  process.env.PUPITRE_CODEX_BIN = join(import.meta.dir, "fake-bins/fake-codex");

  const db = openDb(dir);
  const projects = new ProjectStore(db);
  const conversations = new ConversationStore(db);
  const media = new MediaStore(dir);
  const events = new ConversationEventBus();
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
  const reviews = new ReviewRunner(
    new ReviewStore(db),
    projects,
    conversations,
    quotas,
    async () => '{"flags":[]}',
    subtasks,
  );
  const server = createServer({
    port: 0,
    projects,
    conversations,
    media,
    runner,
    events,
    quotas,
    subtasks,
    presets,
    settings,
    reviews,
  });
  current = {
    baseUrl: `http://127.0.0.1:${server.port}`,
    db,
    runner,
    server,
    reviews,
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
  delete process.env.FAKE_CLAUDE_ARGS_FILE;
  delete process.env.PUPITRE_CODEX_MODE;
});

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

test("CRUD des presets, intégrés immuables et défaut par projet", async () => {
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
    review_provider: "claude",
    review_model: "opus",
    review_effort: "high",
  }));

  const project = await createProject(tmpdir());
  const selected = await putJson(`/api/projects/${project.id}/default-preset`, {
    presetId: preset.id,
  });
  expect(selected.status).toBe(200);
  expect(await selected.json()).toEqual(expect.objectContaining({ default_preset_id: preset.id }));

  const immutable = await fetch(`${current.baseUrl}/api/presets/${builtIns[0]!.id}`, {
    method: "DELETE",
  });
  expect(immutable.status).toBe(409);

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
  const conversation = new ConversationStore(current.db).create({
    projectId: project.id,
    provider: "codex",
    model: "gpt-5.6-luna",
    firstMessage: "change la valeur",
  });
  const started = await postJson("/api/reviews", {
    conversationId: conversation.id,
    reviewProvider: "codex",
    reviewModel: "gpt-5.6-sol",
    reviewEffort: "high",
    codeProvider: "claude",
  });
  expect(started.status).toBe(201);
  const created = await started.json() as { id: string; status: string };
  expect(created.status).toBe("running");
  await current.reviews.wait(created.id);

  const detail = await fetch(`${current.baseUrl}/api/reviews/${created.id}`);
  expect(detail.status).toBe(200);
  expect(await detail.json()).toEqual(expect.objectContaining({
    id: created.id,
    project_id: project.id,
    conversation_id: conversation.id,
    status: "done",
    review_provider: "codex",
    review_model: "gpt-5.6-sol",
    code_provider: "claude",
    flags: [],
  }));
  const list = await fetch(`${current.baseUrl}/api/projects/${project.id}/reviews`);
  expect(list.status).toBe(200);
  expect(await list.json()).toEqual([
    expect.objectContaining({ id: created.id, status: "done" }),
  ]);
});

test("le mode bloquant et l'acquittement ciblé sont exposés sans approbation globale", async () => {
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
  const decision = storedReview.decisions[0]!;

  const mode = await putJson(`/api/projects/${project.id}/gardien-mode`, {
    mode: "bloquant",
  });
  expect(mode.status).toBe(200);
  expect(await mode.json()).toEqual(expect.objectContaining({ gardien_mode: "bloquant" }));
  const blocked = await fetch(`${current.baseUrl}/api/projects/${project.id}/gardien-status`);
  expect(await blocked.json()).toEqual({ mode: "bloquant", blocked: true, openRedCount: 1 });

  const invalidCombined = await fetch(`${current.baseUrl}/api/review-flags/${flag.id}`, {
    method: "PATCH",
    headers: jsonHeaders(),
    body: JSON.stringify({ status: "acked", codeProvider: "invalide" }),
  });
  expect(invalidCombined.status).toBe(400);
  expect(reviewStore.getFlag(flag.id)).toMatchObject({
    status: "open",
    code_provider: "codex",
  });

  const acked = await fetch(`${current.baseUrl}/api/review-decisions/${decision.id}`, {
    method: "PATCH",
    headers: jsonHeaders(),
    body: JSON.stringify({ status: "acked" }),
  });
  expect(acked.status).toBe(200);
  expect(await acked.json()).toEqual(expect.objectContaining({
    id: decision.id,
    status: "acked",
    flag_ids: [flag.id],
  }));
  const unblocked = await fetch(`${current.baseUrl}/api/projects/${project.id}/gardien-status`);
  expect(await unblocked.json()).toEqual({ mode: "bloquant", blocked: false, openRedCount: 0 });
});

test("expose le contre-avis opposé, global ou ciblé, et l'option automatique rouge", async () => {
  if (!current) throw new Error("serveur de test non démarré");
  const project = await createProject(tmpdir());
  const conversation = new ConversationStore(current.db).create({
    projectId: project.id,
    provider: "codex",
    model: "gpt-5.6-luna",
    firstMessage: "écris le risque",
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
    line_start: 4,
    line_end: 4,
    severity: "red",
    category: "perte de données",
    message: "La suppression doit conserver une sauvegarde.",
  }]);
  const flag = reviewStore.get(review.id)!.flags[0]!;

  const automatic = await putJson(`/api/projects/${project.id}/auto-counter-red`, {
    enabled: true,
  });
  expect(automatic.status).toBe(200);
  expect(await automatic.json()).toEqual(expect.objectContaining({ auto_counter_red: true }));

  const cheap = await postJson(`/api/review-flags/${flag.id}/counter-opinion`, {
    model: "haiku",
    effort: "high",
    codeProvider: "claude",
  });
  expect(cheap.status).toBe(400);
  expect(reviewStore.getFlag(flag.id)?.code_provider).toBe("codex");

  const all = await postJson(`/api/reviews/${review.id}/counter-opinions`, {
    model: "opus",
    effort: "high",
  });
  expect(all.status).toBe(202);
  expect(await all.json()).toEqual([
    expect.objectContaining({
      id: flag.id,
      counter_provider: "claude",
      counter_model: "opus",
      counter_state: "queued",
    }),
  ]);
  const duplicate = await postJson(`/api/review-flags/${flag.id}/counter-opinion`, {
    model: "opus",
    effort: "high",
  });
  expect(duplicate.status).toBe(409);
  await current.reviews.waitCounter(flag.id);

  const author = await fetch(`${current.baseUrl}/api/review-flags/${flag.id}`, {
    method: "PATCH",
    headers: jsonHeaders(),
    body: JSON.stringify({ codeProvider: "claude" }),
  });
  expect(author.status).toBe(200);
  expect(await author.json()).toEqual(expect.objectContaining({
    id: flag.id,
    code_provider: "claude",
  }));
  const targeted = await postJson(`/api/review-flags/${flag.id}/counter-opinion`, {
    model: "gpt-5.6-sol",
    effort: "high",
  });
  expect(targeted.status).toBe(202);
  expect(await targeted.json()).toEqual([
    expect.objectContaining({ id: flag.id, counter_provider: "codex" }),
  ]);
  await current.reviews.waitCounter(flag.id);
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
  expect(await emptySettings.json()).toEqual({});

  const saved = await putJson("/api/settings", {
    quotaThresholds: { lastHour: false, usedPercent: 91 },
  });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual({
    quotaThresholds: { lastHour: false, usedPercent: 91 },
  });

  const invalid = await putJson("/api/settings", {
    quotaThresholds: { lastHour: true, usedPercent: 101 },
  });
  expect(invalid.status).toBe(400);
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
  const done = await waitForWebSocketEvent(
    wsUrl,
    (event) => event.type === "status" && event.state === "done",
  );
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
  };
  expect(continuation).toMatchObject({
    continued_from: source.id,
    provider: "codex",
  });

  const events = await fetch(
    `${current.baseUrl}/api/conversations/${continuation.id}/events`,
  ).then((result) => result.json()) as StoredEvent[];
  expect(events[0]).toMatchObject({
    type: "user-message",
    text: expect.stringContaining("BONJOUR PUPITRE"),
  });
  expect(events.at(-1)).toMatchObject({ type: "status", state: "done" });

  const list = await fetch(
    `${current.baseUrl}/api/projects/${project.id}/conversations`,
  ).then((result) => result.json()) as Array<{ id: string; continued_from: string | null }>;
  expect(list).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: continuation.id, continued_from: source.id }),
  ]));
});

test("un tour actif répond 409, puis cancel l'annule et déverrouille la conversation", async () => {
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

  const conflict = await postJson(
    `/api/conversations/${conversation.id}/messages`,
    { message: "deuxième" },
  );
  expect(conflict.status).toBe(409);

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
  const unlockedDone = waitForWebSocketEvent(
    wsUrl,
    (event) => event.type === "status" && event.state === "done",
  );
  const next = await postJson(
    `/api/conversations/${conversation.id}/messages`,
    { message: "ATTENDS_WS après annulation" },
  );
  expect(next.status).toBe(202);
  await unlockedDone;
});

test("deux POST messages quasi simultanés ne peuvent pas répondre tous deux 202", async () => {
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

  expect(responses.map((response) => response.status).sort()).toEqual([202, 409]);
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
