import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import type { StoredEvent } from "../src/events";
import { MediaStore } from "../src/media";
import { ConversationRunner } from "../src/runner";
import { ConversationEventBus, createServer } from "../src/server";
import { ConversationStore } from "../src/stores/conversations";
import { ProjectStore } from "../src/stores/projects";
import { PresetStore } from "../src/stores/presets";
import { SettingsStore } from "../src/stores/settings";
import { QuotaTracker } from "../src/quotas";
import { MAX_CONCURRENT_SUBTASKS, SubtaskRunner } from "../src/subtasks";
import { codexAppServer } from "../src/adapters/codex-app-server";
import { ReviewStore } from "../src/stores/reviews";
import { ReviewRunner } from "../src/reviews";
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
import { DebriefStore } from "../src/stores/debriefs";
import { SearchIndex } from "../src/search";
import { CostStore } from "../src/costs";
import { MemoryStore } from "../src/memory";
import { stubQuotaRefresher } from "./stub-quota-refresher";

interface Harness {
  baseUrl: string;
  db: Database;
  server: ReturnType<typeof createServer>;
  runner: ConversationRunner;
  subtasks: SubtaskRunner;
  conversations: ConversationStore;
  releaseFile: string;
}

let current: Harness | undefined;
const previousEnv: Record<string, string | undefined> = {};

function harness(): Harness {
  if (!current) throw new Error("serveur de test non démarré");
  return current;
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(`${harness().baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${harness().baseUrl}${path}`);
  return response.json() as Promise<T>;
}

/** Crée un projet + une conversation parente (sans lancer de tour parent). */
function parentConversation(provider: "claude" | "codex" = "claude"): string {
  const projects = new ProjectStore(harness().db);
  const project = projects.list()[0] ?? projects.create({ name: "p", path: tmpdir() });
  return harness().conversations.create({
    projectId: project.id,
    provider,
    model: "haiku",
    firstMessage: "orchestre",
  }).id;
}

interface SubtaskResultBody {
  status: string;
  resultText: string;
  error: string | null;
  subtask: { id: string; provider: string; model: string; label: string | null };
}

async function waitForSubtask(id: string, timeoutMs = 8_000): Promise<SubtaskResultBody> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = await getJson<SubtaskResultBody>(`/api/subtasks/${id}`);
    if (body.status !== "running") return body;
    await Bun.sleep(20);
  }
  throw new Error("timeout sous-tâche");
}

beforeEach(() => {
  current = undefined;
  const dir = mkdtempSync(join(tmpdir(), "pupitre-subtasks-"));
  const fixture = join(import.meta.dir, "fixtures/claude-basic.jsonl");
  const releaseFile = join(dir, "release");
  const fakeClaude = join(dir, "fake-claude");
  // Le prompt BLOQUE fait patienter le faux CLI jusqu'au fichier de libération :
  // c'est ce qui permet de tenir N sous-tâches en vol en même temps.
  writeFileSync(fakeClaude, `#!/usr/bin/env bash
IFS= read -r initial
case "$initial" in
  *BLOQUE*) while [ ! -f "${releaseFile}" ]; do sleep 0.02; done ;;
esac
cat "${fixture}"
`);
  chmodSync(fakeClaude, 0o755);

  for (const key of ["PUPITRE_CLAUDE_BIN", "PUPITRE_CODEX_BIN", "PUPITRE_CODEX_MODE"]) {
    previousEnv[key] = process.env[key];
  }
  process.env.PUPITRE_CLAUDE_BIN = fakeClaude;
  process.env.PUPITRE_CODEX_BIN = join(import.meta.dir, "fake-bins/fake-codex-app-server");
  delete process.env.PUPITRE_CODEX_MODE;

  const db = openDb(dir);
  const projects = new ProjectStore(db);
  const conversations = new ConversationStore(db);
  const media = new MediaStore(dir);
  const events = new ConversationEventBus();
  const quotas = new QuotaTracker(db);
  const runner = new ConversationRunner(
    conversations, projects, media, events.broadcast, quotas, () => 4321,
  );
  const subtasks = new SubtaskRunner(db, conversations, projects, events.broadcast, quotas);
  const presets = new PresetStore(db);
  const settings = new SettingsStore(db);
  const git = new GitProjectService(db, projects);
  const reviewStore = new ReviewStore(db);
  const reviews = new ReviewRunner(reviewStore, projects, conversations, quotas);
  const debriefs = new DebriefRunner(
    new DebriefStore(db), conversations, projects, quotas, events.broadcast,
  );
  const testers = new TesterRunner(
    new TestingStore(db), conversations, projects, reviewStore, quotas,
    events.broadcast, subtasks, async () => '{"items":[]}', runner.activity,
  );
  const skills = new SkillInventory(db, projects, { homeDir: dir });
  skills.refresh();
  const skillSuggestions = new SkillSuggestionService(skills, projects, quotas, async () => []);
  const skillComposer = new SkillComposer(skills, projects, quotas, {
    homeDir: dir,
    generator: async () => "{}",
  });
  const workflows = new WorkflowStore(db);
  const notifications = new NotificationStore(db);
  const routineStore = new RoutineStore(db);
  const routines = new RoutineScheduler(
    routineStore, workflows, presets, projects, conversations, runner, notifications,
  );
  const server = createServer({
    port: 0, projects, conversations, media, runner, events, quotas,
    quotaRefresher: stubQuotaRefresher(quotas),
    subtasks, presets, settings,
    reviews, debriefs, git, testers, skills, skillSuggestions, skillComposer, workflows,
    notifications, routineStore, routines, search: new SearchIndex(db), costs: new CostStore(db),
    memory: new MemoryStore(join(dir, "memory")),
  });
  current = {
    baseUrl: `http://127.0.0.1:${server.port}`,
    db, server, runner, subtasks, conversations, releaseFile,
  };
});

afterEach(() => {
  codexAppServer.shutdown();
  current?.server.stop(true);
  current?.db.close();
  current = undefined;
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("delegate simple : la sous-tâche claude finit en done avec le texte final concaténé", async () => {
  const parentId = parentConversation();
  const created = await postJson("/api/subtasks", {
    conversationId: parentId,
    provider: "claude",
    model: "haiku",
    prompt: "liste le dossier",
    label: "recon",
  });
  expect(created.status).toBe(201);
  const { id } = await created.json() as { id: string };

  const result = await waitForSubtask(id);
  expect(result.status).toBe("done");
  expect(result.resultText).toBe(
    "BONJOUR PUPITRE.\nLe dossier courant est vide (aucun fichier ni sous-dossier).",
  );
  expect(result.subtask.label).toBe("recon");

  // Les events de la sous-tâche sont rejouables sous SON id.
  const events = await getJson<StoredEvent[]>(`/api/subtasks/${id}/events`);
  expect(events[0]).toMatchObject({ type: "user-message", text: "liste le dossier" });
  expect(events.at(-1)).toMatchObject({ type: "status", state: "done" });
  expect(events.map((event) => event.id)).toEqual([...events.map((e) => e.id)].sort((a, b) => a - b));
});

test("un subtask-ref est appendé à la conversation parente au lancement", async () => {
  const parentId = parentConversation();
  const { id } = await (await postJson("/api/subtasks", {
    conversationId: parentId,
    provider: "claude",
    model: "haiku",
    effort: "high",
    prompt: "analyse",
    label: "audit",
  })).json() as { id: string };

  const parentEvents = await getJson<StoredEvent[]>(`/api/conversations/${parentId}/events`);
  const ref = parentEvents.find((event) => event.type === "subtask-ref");
  expect(ref).toMatchObject({
    type: "subtask-ref", subtaskId: id, provider: "claude", model: "haiku", label: "audit",
  });
  // Le fil parent ne contient QUE la référence : le transcript vit sous l'id de
  // la sous-tâche.
  expect(parentEvents.some((event) => event.type === "text-final")).toBe(false);
  await waitForSubtask(id);
});

test("le WS par conversation diffuse les events de la sous-tâche sous son id", async () => {
  const parentId = parentConversation();
  const { id } = await (await postJson("/api/subtasks", {
    conversationId: parentId,
    provider: "claude",
    model: "haiku",
    prompt: "BLOQUE puis réponds",
  })).json() as { id: string };

  const received: StoredEvent[] = [];
  const socket = new WebSocket(
    `ws://127.0.0.1:${new URL(harness().baseUrl).port}/ws?conversation=${id}`,
  );
  const terminal = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout WS sous-tâche")), 8_000);
    socket.addEventListener("open", () => writeFileSync(harness().releaseFile, "go"));
    socket.addEventListener("message", (message) => {
      const event = JSON.parse(String(message.data)) as StoredEvent;
      received.push(event);
      if (event.type === "status" && event.state === "done") {
        clearTimeout(timer);
        socket.close();
        resolve();
      }
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("erreur WebSocket"));
    });
  });

  await terminal;
  expect(received.some((event) => event.type === "text-final")).toBe(true);
  expect(received.every((event) => typeof event.id === "number")).toBe(true);
});

test("deux sous-tâches codex tournent en parallèle sur la même conversation", async () => {
  const parentId = parentConversation("claude");
  const ids = await Promise.all([1, 2].map(async (index) => {
    const response = await postJson("/api/subtasks", {
      conversationId: parentId,
      provider: "codex",
      model: "gpt-5.6-luna",
      speed: "fast",
      prompt: `tâche ${index}`,
      label: `t${index}`,
    });
    expect(response.status).toBe(201);
    return (await response.json() as { id: string }).id;
  }));
  expect(new Set(ids).size).toBe(2);
  // Les deux sont en vol en même temps : la limite les compte toutes les deux.
  expect(harness().subtasks.runningCount(parentId)).toBe(2);

  const results = await Promise.all(ids.map((id) => waitForSubtask(id)));
  for (const [index, result] of results.entries()) {
    expect(result.status).toBe("done");
    expect(result.resultText.length).toBeGreaterThan(0);
    expect(result.subtask.label).toBe(`t${index + 1}`);
  }

  // Chaque transcript ne contient que son propre prompt : pas de mélange entre
  // les deux threads multiplexés sur le même process app-server.
  for (const [index, id] of ids.entries()) {
    const events = await getJson<StoredEvent[]>(`/api/subtasks/${id}/events`);
    expect(events[0]).toMatchObject({ type: "user-message", text: `tâche ${index + 1}` });
    const sessions = events.filter((event) => event.type === "session");
    expect(sessions).toHaveLength(1);
  }
  const [first, second] = await Promise.all(ids.map((id) =>
    getJson<StoredEvent[]>(`/api/subtasks/${id}/events`)));
  const sessionId = (events: StoredEvent[]) =>
    events.find((event) => event.type === "session") as { cliSessionId: string };
  expect(sessionId(first!).cliSessionId).not.toBe(sessionId(second!).cliSessionId);

  // Deux subtask-ref distincts dans le fil parent (fan-out).
  const parentEvents = await getJson<StoredEvent[]>(`/api/conversations/${parentId}/events`);
  expect(parentEvents.filter((event) => event.type === "subtask-ref")).toHaveLength(2);
});

test("binaire introuvable : la sous-tâche finit en error, statut persisté", async () => {
  process.env.PUPITRE_CLAUDE_BIN = join(tmpdir(), `absent-${crypto.randomUUID()}`);
  const parentId = parentConversation();
  const { id } = await (await postJson("/api/subtasks", {
    conversationId: parentId,
    provider: "claude",
    model: "haiku",
    prompt: "va échouer",
  })).json() as { id: string };

  const result = await waitForSubtask(id);
  expect(result.status).toBe("error");
  expect(result.resultText).toBe("");
  // Le message d'échec remonte dans le résultat : sans lui, l'orchestrateur (et
  // la carte repliée de l'UI) ne voient qu'un « ÉCHEC » sans cause.
  expect(result.error).toContain("absent-");
  const events = await getJson<StoredEvent[]>(`/api/subtasks/${id}/events`);
  expect(events.at(-1)).toMatchObject({ type: "status", state: "error" });
  // La ligne en base porte bien le statut terminal (pas de 'running' fantôme).
  expect(harness().subtasks.get(id)!.status).toBe("error");
});

test(`au-delà de ${MAX_CONCURRENT_SUBTASKS} sous-tâches simultanées, l'API répond 429`, async () => {
  const parentId = parentConversation();
  const otherParentId = parentConversation();
  const spawn = (conversationId: string) => postJson("/api/subtasks", {
    conversationId,
    provider: "claude",
    model: "haiku",
    prompt: "BLOQUE ici",
  });

  const ids: string[] = [];
  for (let index = 0; index < MAX_CONCURRENT_SUBTASKS; index += 1) {
    const response = await spawn(parentId);
    expect(response.status).toBe(201);
    ids.push((await response.json() as { id: string }).id);
  }

  const refused = await spawn(parentId);
  expect(refused.status).toBe(429);

  // La limite est PAR conversation : une autre conversation reste servie.
  const other = await spawn(otherParentId);
  expect(other.status).toBe(201);
  ids.push((await other.json() as { id: string }).id);

  writeFileSync(harness().releaseFile, "go");
  await Promise.all(ids.map((id) => waitForSubtask(id)));
  expect(harness().subtasks.runningCount(parentId)).toBe(0);

  // Une fois les slots libérés, la conversation accepte à nouveau.
  const again = await spawn(parentId);
  expect(again.status).toBe(201);
  await waitForSubtask((await again.json() as { id: string }).id);
});

test("annuler le tour parent annule EN CASCADE ses sous-tâches en vol", async () => {
  const parentId = parentConversation();
  const otherParentId = parentConversation();
  const parentRun = harness().runner.runTurn(parentId, "BLOQUE parent", []);
  expect(harness().runner.isRunning(parentId)).toBe(true);
  const spawn = (conversationId: string) => postJson("/api/subtasks", {
    conversationId, provider: "claude", model: "haiku", prompt: "BLOQUE ici",
  });

  const ids: string[] = [];
  for (let index = 0; index < 2; index += 1) {
    const response = await spawn(parentId);
    expect(response.status).toBe(201);
    ids.push((await response.json() as { id: string }).id);
  }
  // Une sous-tâche d'une AUTRE conversation : la cascade ne doit pas la toucher.
  const untouched = (await (await spawn(otherParentId)).json() as { id: string }).id;
  expect(harness().subtasks.runningCount(parentId)).toBe(2);

  // Aucun tour parent en cours ici, mais deux sous-tâches en vol : l'annulation
  // reste acceptée (202) et clôt les deux, sinon elles resteraient orphelines.
  const cancelled = await postJson(`/api/conversations/${parentId}/cancel`, {});
  expect(cancelled.status).toBe(202);
  await parentRun;
  expect(harness().runner.isRunning(parentId)).toBe(false);

  for (const id of ids) {
    expect(harness().subtasks.get(id)!.status).toBe("error");
    expect(harness().conversations.listEvents(id).at(-1))
      .toMatchObject({ type: "status", state: "error", error: "annulé" });
  }
  expect(harness().subtasks.runningCount(parentId)).toBe(0);
  expect(harness().subtasks.get(untouched)!.status).toBe("running");

  // Plus rien à annuler sur ce parent : 409, comme pour un tour absent.
  expect((await postJson(`/api/conversations/${parentId}/cancel`, {})).status).toBe(409);

  writeFileSync(harness().releaseFile, "go");
  await waitForSubtask(untouched);
});

test("le résultat d'une sous-tâche annulée porte l'erreur terminale", async () => {
  const parentId = parentConversation();
  const { id } = await (await postJson("/api/subtasks", {
    conversationId: parentId, provider: "claude", model: "haiku", prompt: "BLOQUE ici",
  })).json() as { id: string };

  expect((await postJson(`/api/subtasks/${id}/cancel`, {})).status).toBe(202);
  const result = await getJson<SubtaskResultBody>(`/api/subtasks/${id}`);
  expect(result).toMatchObject({ status: "error", error: "annulé" });

  writeFileSync(harness().releaseFile, "go");
});

test("une sous-tâche terminée ne laisse pas sa promesse dans la table des runs", async () => {
  const parentId = parentConversation();
  const runner = harness().subtasks;
  const subtask = runner.start({
    conversationId: parentId, provider: "claude", model: "haiku", prompt: "salut",
  });
  // Accès à l'état interne : la fuite mémoire visée n'est pas observable
  // autrement (une Map qui grossit à chaque délégation d'une session longue).
  const runs = (runner as unknown as { runs: Map<string, unknown> }).runs;
  expect(runs.size).toBe(1);

  await runner.waitResult(subtask.id);
  expect(runs.size).toBe(0);

  // Et les deux consommateurs de la table continuent de répondre correctement.
  expect(await runner.waitResult(subtask.id)).toMatchObject({ status: "done" });
  expect(await runner.cancel(subtask.id)).toBe(false);
});

test("routes de sous-tâche : 404 sur id inconnu, 404 sur conversation parente inconnue", async () => {
  expect((await fetch(`${harness().baseUrl}/api/subtasks/inconnu`)).status).toBe(404);
  expect((await fetch(`${harness().baseUrl}/api/subtasks/inconnu/events`)).status).toBe(404);
  const response = await postJson("/api/subtasks", {
    conversationId: "inconnue", provider: "claude", model: "haiku", prompt: "x",
  });
  expect(response.status).toBe(404);
});

test("waitResult attend la fin du tour et rend le résultat concaténé", async () => {
  const parentId = parentConversation();
  const subtask = harness().subtasks.start({
    conversationId: parentId,
    provider: "claude",
    model: "haiku",
    prompt: "salut",
  });
  const result = await harness().subtasks.waitResult(subtask.id);
  expect(result).toMatchObject({ status: "done" });
  expect(result!.resultText).toContain("BONJOUR PUPITRE.");
  expect(harness().subtasks.listByConversation(parentId).map((row) => row.id))
    .toEqual([subtask.id]);
});

test("les sous-tâches orphelines d'un redémarrage sont clôturées en erreur", async () => {
  const parentId = parentConversation();
  const { db, conversations } = harness();
  const projects = new ProjectStore(db);
  const orphan = harness().subtasks.start({
    conversationId: parentId,
    provider: "claude",
    model: "haiku",
    prompt: "BLOQUE ici",
  });
  expect(harness().subtasks.get(orphan.id)!.status).toBe("running");

  // Nouveau SubtaskRunner sur la même base = redémarrage du sidecar.
  const revived = new SubtaskRunner(
    db, conversations, projects, () => {}, new QuotaTracker(db),
  );
  expect(revived.get(orphan.id)!.status).toBe("error");
  expect(conversations.listEvents(orphan.id).at(-1))
    .toMatchObject({ type: "status", state: "error" });

  writeFileSync(harness().releaseFile, "go");
  await harness().subtasks.waitResult(orphan.id);
});

test("migration : la clé étrangère d'events est retirée sans perdre de ligne", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pupitre-migration-"));
  // Base au schéma d'avant M2-D1 : events.conversation_id REFERENCES conversations.
  const legacy = new Database(join(dir, "pupitre.db"));
  legacy.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
      permission_mode TEXT NOT NULL DEFAULT 'acceptEdits',
      pinned INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
      title TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
      cli_session_id TEXT, pinned INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      payload TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX idx_events_conv ON events(conversation_id, id);
    INSERT INTO projects VALUES ('p', 'n', '/tmp', 'acceptEdits', 0, 'now');
    INSERT INTO conversations VALUES ('c', 'p', 't', 'claude', 'haiku', NULL, 0, 'now', 'now');
    INSERT INTO events (conversation_id, payload, created_at)
      VALUES ('c', '{"type":"status","state":"done"}', 'now');
  `);
  legacy.close();

  const migrated = openDb(dir);
  const ddl = migrated.query("SELECT sql FROM sqlite_master WHERE name = 'events'")
    .get() as { sql: string };
  expect(ddl.sql).not.toContain("REFERENCES");
  expect(migrated.query("SELECT count(*) AS c FROM events").get()).toMatchObject({ c: 1 });
  expect(migrated.query("PRAGMA foreign_keys").get()).toMatchObject({ foreign_keys: 1 });
  // C'est tout l'objet de la migration : écrire sous un id qui n'est pas une conversation.
  migrated.exec(
    "INSERT INTO events (conversation_id, payload, created_at) VALUES ('subtask-x', '{}', 'now')",
  );
  expect(new ConversationStore(migrated).listEvents("subtask-x")).toHaveLength(1);
  migrated.close();

  // Idempotence : rouvrir ne rejoue pas la migration et ne perd rien.
  const reopened = openDb(dir);
  expect(reopened.query("SELECT count(*) AS c FROM events").get()).toMatchObject({ c: 2 });
  reopened.close();
});
