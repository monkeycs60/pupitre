// Le bridge MCP tourne dans un VRAI process (`bun src/conductor-mcp.ts`),
// piloté par un vrai client MCP stdio, contre un sidecar de test à fake bins :
// c'est l'aller-retour complet orchestrateur → outil → HTTP → sous-tâche.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Database } from "bun:sqlite";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import type { StoredEvent } from "../src/events";
import { MediaStore } from "../src/media";
import { QuotaTracker } from "../src/quotas";
import { ConversationRunner } from "../src/runner";
import { ConversationEventBus, createServer } from "../src/server";
import { ConversationStore } from "../src/stores/conversations";
import { ProjectStore } from "../src/stores/projects";
import { PresetStore } from "../src/stores/presets";
import { SettingsStore } from "../src/stores/settings";
import { SubtaskRunner } from "../src/subtasks";
import { codexAppServer } from "../src/adapters/codex-app-server";
import { conductorMcpPath } from "../src/conductor";
import { ReviewStore } from "../src/stores/reviews";
import { ReviewRunner } from "../src/reviews";
import { DebriefRunner } from "../src/debriefs";
import { GitProjectService } from "../src/git";
import { TestingStore } from "../src/stores/testing";
import { TesterRunner } from "../src/testing";
import { SkillInventory } from "../src/skills";
import { SkillComposer } from "../src/skill-composer";
import { WorkflowStore } from "../src/stores/workflows";
import { NotificationStore } from "../src/stores/notifications";
import { RoutineScheduler, RoutineStore } from "../src/routines";
import { DebriefStore } from "../src/stores/debriefs";
import { SearchIndex } from "../src/search";
import { CostStore } from "../src/costs";
import { MemoryStore } from "../src/memory";
import { IntegrationStore } from "../src/stores/integrations";
import { IntegrationsRefresher } from "../src/integrations/refresher";
import { TicketStore } from "../src/stores/tickets";
import { stubQuotaRefresher } from "./stub-quota-refresher";

const BRIDGE_ENV_KEYS = ["PUPITRE_CLAUDE_BIN", "PUPITRE_CODEX_BIN", "PUPITRE_CODEX_MODE"];

let db: Database;
let server: ReturnType<typeof createServer>;
let conversations: ConversationStore;
let subtasks: SubtaskRunner;
let releaseFile: string;
let parentId: string;
let clients: Client[];
const previousEnv: Record<string, string | undefined> = {};

function baseUrl(): string {
  return `http://127.0.0.1:${serverPort()}`;
}

/** Port éphémère du sidecar de test — c'est lui que le bridge rappelle. */
function serverPort(): number {
  if (server.port === undefined) throw new Error("serveur de test non démarré");
  return server.port;
}

/** Un client MCP branché sur un process bridge frais. */
async function connect(env: Record<string, string> = {}): Promise<Client> {
  const client = new Client({ name: "test-orchestrateur", version: "0.0.0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [conductorMcpPath()],
    env: {
      PATH: process.env.PATH ?? "",
      PUPITRE_PORT: String(serverPort()),
      PUPITRE_CONVERSATION_ID: parentId,
      // Poll rapide : le comportement testé est la boucle, pas sa cadence.
      PUPITRE_CONDUCTOR_POLL_MS: "25",
      PUPITRE_CONDUCTOR_TIMEOUT_MS: "20000",
      ...env,
    },
  }));
  clients.push(client);
  return client;
}

interface ToolResult {
  content: { type: string; text?: string }[];
  isError?: boolean;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  return await client.callTool({ name, arguments: args }) as ToolResult;
}

function textOf(result: ToolResult): string {
  return result.content.map((part) => part.text ?? "").join("\n");
}

beforeEach(() => {
  clients = [];
  for (const key of BRIDGE_ENV_KEYS) previousEnv[key] = process.env[key];
  const dir = mkdtempSync(join(tmpdir(), "pupitre-conductor-mcp-"));
  releaseFile = join(dir, "release");
  const fakeClaude = join(dir, "fake-claude");
  // Le prompt BLOQUE tient le faux CLI en vie jusqu'au fichier de libération :
  // c'est ce qui permet de tester l'annulation d'une sous-tâche en vol.
  writeFileSync(fakeClaude, `#!/usr/bin/env bash
IFS= read -r initial
case "$initial" in
  *BLOQUE*) while [ ! -f "${releaseFile}" ]; do sleep 0.02; done ;;
esac
cat "${join(import.meta.dir, "fixtures/claude-basic.jsonl")}"
`);
  chmodSync(fakeClaude, 0o755);
  process.env.PUPITRE_CLAUDE_BIN = fakeClaude;
  process.env.PUPITRE_CODEX_BIN = join(import.meta.dir, "fake-bins/fake-codex-app-server");
  delete process.env.PUPITRE_CODEX_MODE;

  db = openDb(dir);
  const projects = new ProjectStore(db);
  const project = projects.create({ name: "p", path: tmpdir() });
  conversations = new ConversationStore(db);
  const events = new ConversationEventBus();
  const quotas = new QuotaTracker(db);
  // Un relevé de quota connu pour check_quotas.
  quotas.ingestPayload("codex", {
    primary: { usedPercent: 12.5, windowDurationMins: 300, resetsAt: 1_800_000_000 },
    secondary: { usedPercent: 3, windowDurationMins: 10_080, resetsAt: 1_800_600_000 },
  });
  const media = new MediaStore(dir);
  const runner = new ConversationRunner(
    conversations, projects, media, events.broadcast, quotas, serverPort,
  );
  subtasks = new SubtaskRunner(db, conversations, projects, events.broadcast, quotas);
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
  const integrations = new IntegrationStore(db);
  const tickets = new TicketStore(db);
  const integrationsRefresher = new IntegrationsRefresher(
    { integrations, tickets, conversations, projects },
    { clickUpClient: () => null, gitLabClient: () => null },
  );
  server = createServer({
    port: 0, projects, conversations, media, runner, events, quotas,
    quotaRefresher: stubQuotaRefresher(quotas),
    subtasks, presets, settings,
    reviews, debriefs, git, testers, skills, skillComposer, workflows,
    notifications, routineStore, routines, search: new SearchIndex(db), costs: new CostStore(db),
    memory: new MemoryStore(join(dir, "memory")),
    integrations, tickets, integrationsRefresher,
  });
  parentId = conversations.create({
    projectId: project.id, provider: "claude", model: "opus", firstMessage: "orchestre",
  }).id;
});

afterEach(async () => {
  for (const client of clients) await client.close().catch(() => {});
  codexAppServer.shutdown();
  server.stop(true);
  db.close();
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("les trois outils sont exposés avec des descriptions exploitables", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  expect(tools.map((tool) => tool.name).sort())
    .toEqual(["check_quotas", "delegate", "delegate_parallel"]);

  const delegate = tools.find((tool) => tool.name === "delegate")!;
  // Ce que l'orchestrateur lit pour choisir : modèles, efforts, fast codex-only,
  // et la recommandation de routage.
  expect(delegate.description).toContain("gpt-5.6-luna");
  expect(delegate.description).toContain("fable-5");
  expect(delegate.description).toContain("grok-4.6");
  expect(delegate.description).toContain("xhigh");
  expect(delegate.description).toContain("check_quotas");
  expect(delegate.description!.toLowerCase()).toContain("codex");
  expect(Object.keys((delegate.inputSchema as any).properties).sort())
    .toEqual(["conversation_id", "effort", "label", "model", "prompt", "provider", "speed"]);
});

test("delegate : aller-retour complet, la sous-tâche est rattachée au parent", async () => {
  const client = await connect();
  const result = await call(client, "delegate", {
    provider: "claude",
    model: "haiku",
    effort: "low",
    prompt: "liste le dossier",
    label: "recon",
  });

  expect(result.isError).toBeFalsy();
  const rendered = textOf(result);
  expect(rendered).toContain("claude · haiku · effort low · recon");
  expect(rendered).toContain("terminé");
  expect(rendered).toContain("BONJOUR PUPITRE.");

  // Côté sidecar : une sous-tâche terminée, référencée dans le fil parent.
  const rows = subtasks.listByConversation(parentId);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ status: "done", label: "recon", effort: "low" });
  const parentEvents = conversations.listEvents(parentId) as StoredEvent[];
  expect(parentEvents.filter((event) => event.type === "subtask-ref")).toHaveLength(1);
});

test("delegate : une sous-tâche en échec revient en isError avec le contexte", async () => {
  process.env.PUPITRE_CLAUDE_BIN = join(tmpdir(), `absent-${crypto.randomUUID()}`);
  const client = await connect();
  const result = await call(client, "delegate", {
    provider: "claude", model: "haiku", prompt: "va échouer",
  });
  expect(result.isError).toBe(true);
  const rendered = textOf(result);
  expect(rendered).toContain("ÉCHEC");
  // La cause remonte à l'orchestrateur : sans elle, il ne peut ni corriger ni
  // décider de réessayer.
  expect(rendered).toContain("ENOENT");
});

test("delegate : le 429 de la limite de concurrence est encaissé et réessayé", async () => {
  // Les 4 slots de la conversation parente sont pris par des sous-tâches
  // bloquées : l'API répond 429 à toute création supplémentaire.
  const blocking = Array.from({ length: 4 }, () => subtasks.start({
    conversationId: parentId, provider: "claude", model: "haiku", prompt: "BLOQUE ici",
  }));
  expect(subtasks.runningCount(parentId)).toBe(4);

  // PUPITRE_CONDUCTOR_POLL_MS=25 (cf. connect) : le bridge repasse toutes les
  // 25 ms tant qu'aucun slot n'est libre, au lieu d'abandonner sur le 429.
  const client = await connect();
  const pending = call(client, "delegate", {
    provider: "claude", model: "haiku", prompt: "liste le dossier", label: "attend",
  });

  // Le temps de plusieurs tentatives refusées : rien de neuf n'est créé.
  await Bun.sleep(300);
  expect(subtasks.listByConversation(parentId)).toHaveLength(4);

  writeFileSync(releaseFile, "go");
  const result = await pending;

  expect(result.isError).toBeFalsy();
  expect(textOf(result)).toContain("BONJOUR PUPITRE.");
  const rows = subtasks.listByConversation(parentId);
  expect(rows).toHaveLength(5);
  expect(rows.find((row) => row.label === "attend")).toMatchObject({ status: "done" });
  await Promise.all(blocking.map((row) => subtasks.waitResult(row.id)));
});

test("delegate_parallel : deux sous-tâches concurrentes, résultats dans l'ordre", async () => {
  const client = await connect();
  const result = await call(client, "delegate_parallel", {
    tasks: [
      { provider: "claude", model: "haiku", prompt: "tâche A", label: "a" },
      { provider: "codex", model: "gpt-5.6-luna", speed: "fast", prompt: "tâche B", label: "b" },
    ],
  });

  expect(result.isError).toBeFalsy();
  const rendered = textOf(result);
  expect(rendered).toContain("--- tâche 1/2 (a) ---");
  expect(rendered).toContain("--- tâche 2/2 (b) ---");
  expect(rendered.indexOf("tâche 1/2")).toBeLessThan(rendered.indexOf("tâche 2/2"));
  expect(rendered).toContain("claude · haiku · a");
  expect(rendered).toContain("codex · gpt-5.6-luna · fast · b");

  const rows = subtasks.listByConversation(parentId);
  expect(rows).toHaveLength(2);
  expect(rows.every((row) => row.status === "done")).toBe(true);
  expect(rows.map((row) => row.provider).sort()).toEqual(["claude", "codex"]);
});

test("delegate_parallel : au-delà de 4 tâches, l'appel est rejeté par le schéma", async () => {
  const client = await connect();
  const tasks = Array.from({ length: 5 }, (_, index) => ({
    provider: "claude", model: "haiku", prompt: `t${index}`,
  }));
  const result = await call(client, "delegate_parallel", { tasks });
  expect(result.isError).toBe(true);
  expect(subtasks.listByConversation(parentId)).toHaveLength(0);
});

test("check_quotas : rend les fenêtres des deux providers en clair", async () => {
  const client = await connect();
  const rendered = textOf(await call(client, "check_quotas"));
  expect(rendered).toContain("codex");
  expect(rendered).toContain("13 % utilisé");
  expect(rendered).toContain("fenêtre 5 h");
  expect(rendered).toContain("fenêtre 7 j");
  expect(rendered).toContain("claude : aucun relevé");
  expect(rendered).toContain("grok : aucun relevé");
});

test("sans conversation orchestratrice connue, delegate refuse proprement", async () => {
  const client = await connect({ PUPITRE_CONVERSATION_ID: "" });
  const result = await call(client, "delegate", {
    provider: "claude", model: "haiku", prompt: "x",
  });
  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain("PUPITRE_CONVERSATION_ID");

  // Le paramètre explicite est la porte de secours documentée.
  const rescued = await call(client, "delegate", {
    provider: "claude", model: "haiku", prompt: "x", conversation_id: parentId,
  });
  expect(rescued.isError).toBeFalsy();
  expect(subtasks.listByConversation(parentId)).toHaveLength(1);
});

test("cancel : une sous-tâche en vol est interrompue et clôturée en erreur", async () => {
  const subtask = subtasks.start({
    conversationId: parentId, provider: "claude", model: "haiku", prompt: "BLOQUE ici",
  });
  expect(subtasks.get(subtask.id)!.status).toBe("running");

  const cancelled = await fetch(`${baseUrl()}/api/subtasks/${subtask.id}/cancel`, {
    method: "POST",
  });
  expect(cancelled.status).toBe(202);
  expect(subtasks.get(subtask.id)!.status).toBe("error");
  expect(conversations.listEvents(subtask.id).at(-1))
    .toMatchObject({ type: "status", state: "error" });

  // Rejouer l'annulation sur une sous-tâche terminée : 409, pas 202.
  const again = await fetch(`${baseUrl()}/api/subtasks/${subtask.id}/cancel`, { method: "POST" });
  expect(again.status).toBe(409);
  const unknown = await fetch(`${baseUrl()}/api/subtasks/inconnue/cancel`, { method: "POST" });
  expect(unknown.status).toBe(404);
  writeFileSync(releaseFile, "go");
});
