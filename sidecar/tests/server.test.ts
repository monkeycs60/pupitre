import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import type { AppEvent } from "../src/events";
import { MediaStore } from "../src/media";
import { ConversationRunner } from "../src/runner";
import { ConversationEventBus, createServer } from "../src/server";
import { ConversationStore } from "../src/stores/conversations";
import { ProjectStore } from "../src/stores/projects";

interface TestServer {
  baseUrl: string;
  db: Database;
  server: ReturnType<typeof createServer>;
}

let current: TestServer | undefined;
let previousClaudeBin: string | undefined;

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

function waitForWebSocketEvent(
  url: string,
  predicate: (event: AppEvent) => boolean,
): Promise<AppEvent> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("timeout WebSocket"));
    }, 3_000);

    socket.addEventListener("message", (message) => {
      const event = JSON.parse(String(message.data)) as AppEvent;
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

beforeEach(() => {
  current = undefined;
  const dir = mkdtempSync(join(tmpdir(), "pupitre-server-"));
  const fakeClaude = join(dir, "fake-claude");
  const fixture = join(import.meta.dir, "fixtures/claude-basic.jsonl");
  writeFileSync(fakeClaude, `#!/usr/bin/env bash
case "$*" in
  *ATTENDS_WS*) sleep 0.2 ;;
  *BLOQUE*) exec sleep 30 ;;
esac
cat "${fixture}"
`);
  chmodSync(fakeClaude, 0o755);
  previousClaudeBin = process.env.PUPITRE_CLAUDE_BIN;
  process.env.PUPITRE_CLAUDE_BIN = fakeClaude;

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
    server,
  };
});

afterEach(() => {
  current?.server.stop(true);
  current?.db.close();
  current = undefined;
  if (previousClaudeBin === undefined) delete process.env.PUPITRE_CLAUDE_BIN;
  else process.env.PUPITRE_CLAUDE_BIN = previousClaudeBin;
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
  expect(done).toEqual({ type: "status", state: "done" });

  const replay = await fetch(
    `${current.baseUrl}/api/conversations/${conversation.id}/events`,
  );
  expect(replay.status).toBe(200);
  const stored = await replay.json() as AppEvent[];
  expect(stored.length).toBeGreaterThan(1);
  expect(stored[0]).toEqual({
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
  const events = await replay.json() as AppEvent[];
  expect(events.at(-1)).toEqual({
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
