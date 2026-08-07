import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexServerDefinitions, listMcpServers, usedMcpServers } from "../src/mcp-inventory";

function fixture(): { home: string; project: string } {
  const home = mkdtempSync(join(tmpdir(), "pupitre-mcp-home-"));
  const project = mkdtempSync(join(tmpdir(), "pupitre-mcp-project-"));
  writeFileSync(join(home, ".claude.json"), JSON.stringify({
    mcpServers: {
      tavily: { command: "npx", env: { TAVILY_API_KEY: "secret" } },
      figma: { command: "npx" },
    },
    projects: { [project]: { mcpServers: { "projet-only": { command: "node" } } } },
  }));
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "config.toml"), [
    "[mcp_servers.brave-search]",
    'command = "npx"',
    "[mcp_servers.brave-search.env]",
    'BRAVE_API_KEY = "secret"',
    "[mcp_servers.mongodb]",
    'command = "npx"',
  ].join("\n"));
  return { home, project };
}

test("liste les serveurs des deux providers, global et projet", () => {
  const { home, project } = fixture();
  expect(listMcpServers(project, home)).toEqual([
    { name: "tavily", provider: "claude", scope: "global" },
    { name: "figma", provider: "claude", scope: "global" },
    { name: "projet-only", provider: "claude", scope: "projet" },
    { name: "brave-search", provider: "codex", scope: "global" },
    { name: "mongodb", provider: "codex", scope: "global" },
  ]);
});

test("les sous-tables TOML ne créent pas de faux serveurs", () => {
  const { home, project } = fixture();
  const codex = listMcpServers(project, home).filter((server) => server.provider === "codex");
  expect(codex.map((server) => server.name)).toEqual(["brave-search", "mongodb"]);
});

test("aucune clé d'API ne sort de l'inventaire", () => {
  const { home, project } = fixture();
  expect(JSON.stringify(listMcpServers(project, home))).not.toContain("secret");
});

test("un serveur déclaré deux fois n'est compté qu'une fois", () => {
  const { home, project } = fixture();
  writeFileSync(join(project, ".mcp.json"), JSON.stringify({
    mcpServers: { tavily: { command: "npx" }, local: { command: "node" } },
  }));
  const names = listMcpServers(project, home).map((server) => server.name);
  expect(names.filter((name) => name === "tavily")).toHaveLength(1);
  expect(names).toContain("local");
});

test("une configuration absente rend une liste vide, sans erreur", () => {
  const empty = mkdtempSync(join(tmpdir(), "pupitre-mcp-empty-"));
  expect(listMcpServers(empty, empty)).toEqual([]);
});

test("un JSON corrompu n'interrompt pas l'inventaire", () => {
  const { home, project } = fixture();
  writeFileSync(join(project, ".mcp.json"), "{ pas du json");
  expect(listMcpServers(project, home).length).toBeGreaterThan(0);
});

test("lit les définitions Codex : commande, arguments et env", () => {
  const { home } = fixture();
  const definitions = codexServerDefinitions(home) as Record<string, any>;
  expect(definitions["brave-search"]).toEqual({
    command: "npx",
    args: [],
    env: { BRAVE_API_KEY: "secret" },
  });
  expect(definitions.mongodb.command).toBe("npx");
});

test("un serveur Codex sans commande n'est pas retenu", () => {
  const home = mkdtempSync(join(tmpdir(), "pupitre-mcpnocmd-"));
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "config.toml"), [
    "[mcp_servers.fantome]",
    'description = "pas de commande"',
  ].join("\n"));
  expect(Object.keys(codexServerDefinitions(home))).toEqual([]);
});

test("déduit les serveurs appelés depuis les noms d'outils", () => {
  expect(usedMcpServers([
    "mcp__tavily__tavily_search",
    "mcp__reddit-mcp-buddy__browse_subreddit",
    "mcp__tavily__tavily_extract",
    "Read",
    "Bash",
  ]).sort()).toEqual(["reddit-mcp-buddy", "tavily"]);
});

test("un historique sans outil MCP ne suggère rien", () => {
  expect(usedMcpServers(["Read", "Write", "Bash"])).toEqual([]);
});

test("un serveur sans instructions ne coûte que ses noms d'outils", async () => {
  // Calibration : tavily publie 5 outils et aucune instruction ; le CLI mesure
  // 56 tokens de surcoût réel.
  const { weighForTest } = await import("../src/mcp-probe");
  const tools = [
    { name: "tavily_crawl" }, { name: "tavily_extract" }, { name: "tavily_map" },
    { name: "tavily_research" }, { name: "tavily_search" },
  ];
  const weight = weighForTest("tavily", tools, "");
  expect(weight.tokens).toBeGreaterThan(40);
  expect(weight.tokens).toBeLessThan(80);
});

test("les instructions d'un serveur dominent son coût", async () => {
  const { weighForTest } = await import("../src/mcp-probe");
  const tools = [{ name: "a" }, { name: "b" }];
  const sans = weighForTest("x", tools, "");
  const avec = weighForTest("x", tools, "i".repeat(1_000));
  expect(avec.tokens! - sans.tokens!).toBeGreaterThan(200);
});
