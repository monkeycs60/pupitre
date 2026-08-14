// Câblage du bridge MCP « conductor » : QUI reçoit les outils de délégation.
// Le bridge lui-même (aller-retour réel) est testé dans conductor-mcp.test.ts.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { MediaStore } from "../src/media";
import { QuotaTracker } from "../src/quotas";
import { ConversationRunner } from "../src/runner";
import { ConversationStore } from "../src/stores/conversations";
import { ProjectStore } from "../src/stores/projects";
import { SubtaskRunner } from "../src/subtasks";
import { codexAppServer } from "../src/adapters/codex-app-server";
import { conductorMcpPath, conductorServerConfig } from "../src/conductor";
import { pupitreMcpPath } from "../src/pupitre";

let dir: string;
let argsFile: string;
let stdinFile: string;
let appServerLog: string;
let convs: ConversationStore;
let projects: ProjectStore;
let projectId: string;
let runner: ConversationRunner;
let subtasks: SubtaskRunner;
let media: MediaStore;
let quotas: QuotaTracker;
const previousEnv: Record<string, string | undefined> = {};

const ENV_KEYS = [
  "PUPITRE_CLAUDE_BIN", "PUPITRE_CODEX_BIN", "PUPITRE_CODEX_MODE",
  "PUPITRE_CODEX_USER_MCPS", "FAKE_CLAUDE_ARGS_FILE", "FAKE_APP_SERVER_LOG",
];

beforeEach(() => {
  for (const key of ENV_KEYS) previousEnv[key] = process.env[key];
  dir = mkdtempSync(join(tmpdir(), "pupitre-conductor-wiring-"));
  argsFile = join(dir, "args");
  stdinFile = join(dir, "stdin");
  appServerLog = join(dir, "app-server.log");
  // fake-claude n'écrit qu'une ligne : les args d'un tour de sous-tâche
  // écraseraient ceux du parent. On appende à la place.
  const fakeClaude = join(dir, "fake-claude");
writeFileSync(fakeClaude, `#!/usr/bin/env bash
echo "$@" >> "${argsFile}"
IFS= read -r input
printf '%s\n' "$input" >> "${stdinFile}"
cat "${join(import.meta.dir, "fixtures/claude-basic.jsonl")}"
`);
  chmodSync(fakeClaude, 0o755);
  writeFileSync(argsFile, "");
  writeFileSync(stdinFile, "");

  process.env.PUPITRE_CLAUDE_BIN = fakeClaude;
  process.env.PUPITRE_CODEX_BIN = join(import.meta.dir, "fake-bins/fake-codex-app-server");
  process.env.PUPITRE_CODEX_USER_MCPS = "1";
  process.env.FAKE_APP_SERVER_LOG = appServerLog;
  delete process.env.PUPITRE_CODEX_MODE;

  const db = openDb(dir);
  projects = new ProjectStore(db);
  projectId = projects.create({ name: "p", path: tmpdir() }).id;
  convs = new ConversationStore(db);
  quotas = new QuotaTracker(db);
  media = new MediaStore(dir);
  runner = new ConversationRunner(convs, projects, media, () => {}, quotas, () => 4321);
  subtasks = new SubtaskRunner(db, convs, projects, () => {}, quotas);
});

afterEach(() => {
  codexAppServer.shutdown();
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function claudeArgs(): string {
  return readFileSync(argsFile, "utf8");
}

/** Les messages JSON-RPC reçus par le faux app-server. */
function appServerMessages(): { method?: string; params?: any }[] {
  return readFileSync(appServerLog, "utf8").trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("le sidecar compilé relance son bridge conductor embarqué", () => {
  const config = conductorServerConfig(
    { port: 4820, conversationId: "conversation-release" },
    "/usr/bin/pupitre-sidecar",
  );
  expect(config).toEqual({
    command: "/usr/bin/pupitre-sidecar",
    args: ["--conductor-mcp"],
    env: {
      PUPITRE_PORT: "4820",
      PUPITRE_CONVERSATION_ID: "conversation-release",
    },
  });
});

test("bun.exe lance le source conductor en développement Windows", () => {
  const config = conductorServerConfig(
    { port: 4820, conversationId: "conversation-windows" },
    "C:\\Users\\clement\\.bun\\bin\\bun.exe",
  );
  expect(config.command).toBe("C:\\Users\\clement\\.bun\\bin\\bun.exe");
  expect(config.args).toEqual([conductorMcpPath()]);
});

test("conversation orchestratrice claude : --mcp-config inline pointant sur le bridge", async () => {
  const conv = convs.create({
    projectId, provider: "claude", model: "haiku", firstMessage: "orchestre",
  });
  expect(conv.orchestrator).toBe(true); // défaut ON
  await runner.runTurn(conv.id, "orchestre", []);

  const args = claudeArgs();
  expect(args).toContain("--mcp-config");
  expect(args).toContain("--allowedTools mcp__conductor__delegate,mcp__conductor__delegate_parallel,mcp__conductor__check_quotas");
  const config = JSON.parse(args.slice(args.indexOf("{"), args.lastIndexOf("}") + 1));
  expect(config.mcpServers.conductor.args).toEqual([conductorMcpPath()]);
  expect(config.mcpServers.conductor.env).toEqual({
    PUPITRE_PORT: "4321",
    PUPITRE_CONVERSATION_ID: conv.id,
  });
});

test("orchestrator = false : Pupitre reste disponible sans câbler conductor", async () => {
  const conv = convs.create({
    projectId, provider: "claude", model: "haiku",
    orchestrator: false, firstMessage: "simple",
  });
  expect(conv.orchestrator).toBe(false);
  await runner.runTurn(conv.id, "simple", []);
  const args = claudeArgs();
  const config = JSON.parse(args.slice(args.indexOf("{"), args.lastIndexOf("}") + 1));
  expect(config.mcpServers.conductor).toBeUndefined();
  expect(config.mcpServers.pupitre.args).toEqual([pupitreMcpPath()]);
  expect(args).toContain("mcp__pupitre__publish_html_document");
});

test("conversation orchestratrice codex : mcp_servers dans la config du thread", async () => {
  const conv = convs.create({
    projectId, provider: "codex", model: "gpt-5.6-luna", effort: "low",
    firstMessage: "orchestre",
  });
  await runner.runTurn(conv.id, "orchestre", []);

  const start = appServerMessages().find((message) => message.method === "thread/start");
  expect(start).toBeDefined();
  // La config est PAR THREAD : c'est ce qui permet de donner à chaque tour son
  // propre PUPITRE_CONVERSATION_ID malgré le process app-server partagé.
  expect(start!.params.config.mcp_servers.conductor.enabled).toBe(true);
  expect(start!.params.config.mcp_servers.conductor.args).toEqual([conductorMcpPath()]);
  expect(start!.params.config.mcp_servers.conductor.env).toEqual({
    PUPITRE_PORT: "4321",
    PUPITRE_CONVERSATION_ID: conv.id,
  });
  // L'effort reste transmis à côté.
  expect(start!.params.config.model_reasoning_effort).toBe("low");
});

test("port du sidecar non résolu : le tour orchestrateur échoue explicitement", async () => {
  // Un runner mal câblé (fournisseur de port qui rend 0) donnait silencieusement
  // PUPITRE_PORT=0 au bridge : les délégations partaient vers un port mort et
  // l'orchestrateur ne voyait qu'un timeout d'outil, 15 min plus tard.
  const broken = new ConversationRunner(
    convs, projects, media, () => {}, quotas, () => 0,
  );
  const conv = convs.create({
    projectId, provider: "claude", model: "haiku", firstMessage: "orchestre",
  });

  await expect(broken.runTurn(conv.id, "orchestre", [])).rejects.toThrow(/port/i);
  expect(claudeArgs()).toBe(""); // aucun CLI lancé
  expect(convs.listEvents(conv.id).at(-1))
    .toMatchObject({ type: "status", state: "error" });

  // Sans orchestration, le même runner tourne normalement : la garde ne
  // concerne que le câblage du bridge.
  const plain = convs.create({
    projectId, provider: "claude", model: "haiku",
    orchestrator: false, firstMessage: "simple",
  });
  await broken.runTurn(plain.id, "simple", []);
  // La consigne de format précède la demande ; c'est bien le CLI qui a tourné.
  expect(readFileSync(stdinFile, "utf8")).toContain("simple");
});

test("garde de profondeur : un tour de sous-tâche ne reçoit jamais le conductor", async () => {
  const conv = convs.create({
    projectId, provider: "claude", model: "haiku", firstMessage: "orchestre",
  });
  await runner.runTurn(conv.id, "orchestre", []);
  expect(claudeArgs()).toContain("--mcp-config"); // le parent, lui, l'a

  const subtask = subtasks.start({
    conversationId: conv.id, provider: "claude", model: "haiku", prompt: "sous-tâche",
  });
  await subtasks.waitResult(subtask.id);

  // Le digest asynchrone invoque aussi le fake Claude, et les prompts sont
  // multi-lignes : seule la ligne de flags d'un vrai tour porte
  // `--permission-mode`.
  const turns = claudeArgs().trim().split("\n")
    .filter((line) => line.includes("--permission-mode"));
  expect(turns).toHaveLength(2);
  expect(readFileSync(stdinFile, "utf8")).toContain("sous-tâche");
  expect(turns[1]).not.toContain("--mcp-config");
});

test("garde de profondeur (codex) : la sous-tâche démarre un thread sans mcp_servers", async () => {
  const conv = convs.create({
    projectId, provider: "claude", model: "haiku", firstMessage: "orchestre",
  });
  const subtask = subtasks.start({
    conversationId: conv.id, provider: "codex", model: "gpt-5.6-luna", prompt: "sous-tâche",
  });
  await subtasks.waitResult(subtask.id);

  const starts = appServerMessages().filter((message) => message.method === "thread/start");
  expect(starts).toHaveLength(1);
  expect(starts[0]!.params.config?.mcp_servers).toBeUndefined();
});
