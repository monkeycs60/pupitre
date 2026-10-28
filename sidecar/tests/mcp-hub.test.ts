import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { claudeLoadedServers, McpHub } from "../src/mcp-hub";

const FAKE_SERVER = resolve(import.meta.dir, "fixtures/fake-mcp-server.ts");
const hubs: McpHub[] = [];

afterEach(() => {
  for (const hub of hubs.splice(0)) hub.shutdown();
  delete process.env.PUPITRE_MCP_HUB;
});

function setup(options: { idleMs?: number } = {}) {
  const home = mkdtempSync(join(tmpdir(), "pupitre-mcphub-home-"));
  const spawnLog = join(home, "spawns.log");
  writeFileSync(spawnLog, "");
  const fake = {
    command: process.execPath,
    args: [FAKE_SERVER],
    env: { FAKE_MCP_SPAWN_LOG: spawnLog, FAKE_MCP_TAG: "global" },
  };
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { fake } }));
  const hub = new McpHub({ home, ...options });
  hub.attach(() => 4999);
  hubs.push(hub);
  const spawns = () => readFileSync(spawnLog, "utf8").split("\n").filter(Boolean).length;
  return { hub, home, fake, spawns };
}

function urlOf(servers: Record<string, unknown>, name: string): string {
  return (servers[name] as { url: string }).url;
}

async function call(hub: McpHub, url: string, body: unknown, sessionId?: string) {
  const response = await hub.handle(new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(sessionId ? { "mcp-session-id": sessionId } : {}) },
    body: JSON.stringify(body),
  }));
  const isJson = response.headers.get("content-type")?.includes("application/json") === true;
  return { status: response.status, sessionId: response.headers.get("mcp-session-id"), body: isJson ? await response.json() as any : null };
}

async function connect(hub: McpHub, url: string) {
  const init = await call(hub, url, { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
  expect(init.body.result.serverInfo.name).toBe("fake");
  expect((await call(hub, url, { jsonrpc: "2.0", method: "notifications/initialized" }, init.sessionId!)).status).toBe(202);
  return (id: number, name: string, args: Record<string, unknown>) =>
    call(hub, url, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, init.sessionId!);
}

test("deux agents partagent un seul process et reçoivent chacun leur réponse sous leur propre id", async () => {
  const { hub, home, spawns } = setup();
  const firstAgent = hub.claudeServers("/tmp/projet-a", null);
  const secondAgent = hub.claudeServers("/tmp/projet-b", null);
  expect(urlOf(firstAgent, "fake")).toBe(urlOf(secondAgent, "fake"));

  const first = await connect(hub, urlOf(firstAgent, "fake"));
  const second = await connect(hub, urlOf(secondAgent, "fake"));
  const [slow, quick] = await Promise.all([
    first(1, "slow", { text: "premier", ms: 150 }),
    second(1, "echo", { text: "second" }),
  ]);

  expect(slow.body).toEqual({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: `premier|${home}|global` }] } });
  expect(quick.body).toEqual({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: `second|${home}|global` }] } });
  expect(spawns()).toBe(1);
  expect(hub.runningCount()).toBe(1);
});

test("un serveur mort est relancé à la requête suivante, un serveur inactif est arrêté", async () => {
  const { hub, spawns } = setup({ idleMs: 100 });
  const url = urlOf(hub.claudeServers("/tmp/projet", null), "fake");
  const tool = await connect(hub, url);

  const crashed = await tool(1, "crash", {});
  expect(crashed.body.error.message).toContain("arrêté");
  expect((await tool(2, "echo", { text: "relancé" })).body.result.content[0].text).toStartWith("relancé|");
  expect(spawns()).toBe(2);

  await Bun.sleep(300);
  expect(hub.runningCount()).toBe(0);
  expect((await tool(3, "echo", { text: "réveillé" })).body.result.content[0].text).toStartWith("réveillé|");
  expect(spawns()).toBe(3);
});

test("sans sélection : remplace les seuls serveurs stdio que le CLI lancerait, hors navigateurs et désactivés", () => {
  const { hub, home, fake } = setup();
  const project = mkdtempSync(join(tmpdir(), "pupitre-mcphub-projet-"));
  writeFileSync(join(home, ".claude.json"), JSON.stringify({
    mcpServers: { fake, figma: { type: "http", url: "https://mcp.figma.com/mcp" } },
    projects: { [project]: {
      mcpServers: {
        mongodb: { type: "stdio", command: "npx", args: ["-y", "mongodb-mcp-server"] },
        playwright: { command: "npx", args: ["@playwright/mcp@latest"] },
        n8n: { command: "npx", args: ["n8n-mcp"] },
      },
      disabledMcpServers: ["n8n"],
    } },
  }));
  writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: {
    approuve: { command: "node", args: ["serveur.js"] },
    inconnu: { command: "node", args: ["autre.js"] },
  } }));
  mkdirSync(join(project, ".claude"));
  writeFileSync(join(project, ".claude", "settings.json"), JSON.stringify({ enabledMcpjsonServers: ["approuve"] }));

  expect(Object.keys(claudeLoadedServers(project, home)).sort()).toEqual(["approuve", "fake", "figma", "mongodb", "playwright"]);
  const servers = hub.claudeServers(project, null);
  expect(Object.keys(servers).sort()).toEqual(["approuve", "fake", "mongodb"]);
  expect(servers.fake).toEqual({ type: "http", url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:4999\/mcp-hub\//) });
});

test("avec sélection : garde tous les serveurs retenus et ne remplace que les stdio partageables", () => {
  const { hub, fake } = setup();
  const selected = {
    fake,
    figma: { type: "http", url: "https://mcp.figma.com/mcp" },
    chrome: { command: "npx", args: ["chrome-devtools-mcp@latest"] },
  };
  const servers = hub.claudeServers("/tmp/projet", selected);
  expect(servers.figma).toEqual(selected.figma);
  expect(servers.chrome).toEqual(selected.chrome);
  expect((servers.fake as { type: string }).type).toBe("http");
});

test("les serveurs du projet tournent dans le dossier de l'agent, un par dossier", async () => {
  const { hub, home, fake } = setup();
  const project = mkdtempSync(join(tmpdir(), "pupitre-mcphub-local-"));
  writeFileSync(join(home, ".claude.json"), JSON.stringify({
    projects: { [project]: { mcpServers: { local: { ...fake, env: { ...fake.env, FAKE_MCP_TAG: "local" } } } } },
  }));
  const tool = await connect(hub, urlOf(hub.claudeServers(project, null), "local"));
  expect((await tool(1, "echo", { text: "x" })).body.result.content[0].text).toBe(`x|${project}|local`);
});

test("hub coupé, sans port ou jeton inconnu : comportement natif du CLI", async () => {
  const { hub, fake } = setup();
  process.env.PUPITRE_MCP_HUB = "0";
  expect(hub.claudeServers("/tmp/projet", null)).toEqual({});
  expect(hub.claudeServers("/tmp/projet", { fake })).toEqual({ fake });
  expect(new McpHub().claudeServers("/tmp/projet", null)).toEqual({});
  delete process.env.PUPITRE_MCP_HUB;

  const url = urlOf(hub.claudeServers("/tmp/projet", null), "fake");
  const forged = url.replace(/mcp-hub\/[^/]+\//, "mcp-hub/faux-jeton/");
  expect((await call(hub, forged, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(404);
});
