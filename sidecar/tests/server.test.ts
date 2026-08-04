import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import type { AppEvent, StoredEvent } from "../src/events";
import { MediaStore } from "../src/media";
import { ConversationRunner } from "../src/runner";
import { ConversationEventBus, createServer } from "../src/server";
import { ConversationStore } from "../src/stores/conversations";
import { ProjectStore } from "../src/stores/projects";

interface TestServer {
  baseUrl: string;
  db: Database;
  runner: ConversationRunner;
  server: ReturnType<typeof createServer>;
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
  *BLOQUE*) exec sleep 30 ;;
esac
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
  const runner = new ConversationRunner(
    conversations,
    projects,
    media,
    events.broadcast,
  );
  const server = createServer({
    port: 0,
    projects,
    conversations,
    media,
    runner,
    events,
  });
  current = {
    baseUrl: `http://127.0.0.1:${server.port}`,
    db,
    runner,
    server,
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

test("rejette les Origin distants et accepte localhost ou l'absence d'Origin", async () => {
  if (!current) throw new Error("serveur de test non démarré");
  const evil = await fetch(`${current.baseUrl}/api/health`, {
    headers: { Origin: "https://evil.com" },
  });
  expect(evil.status).toBe(403);

  const localhost = await fetch(`${current.baseUrl}/api/health`, {
    headers: { Origin: "http://localhost:5173" },
  });
  expect(localhost.status).toBe(200);

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

test("les événements diffusés en WS portent les mêmes ids croissants que le replay", async () => {
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
    expect(stored.find((candidate) => candidate.id === event.id)).toEqual(event);
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
