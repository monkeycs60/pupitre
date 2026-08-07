import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { ProjectStore } from "../src/stores/projects";
import { claudeServerDefinitions } from "../src/mcp-inventory";
import { claudeMcpConfigArg } from "../src/conductor";

let projects: ProjectStore;

beforeEach(() => {
  projects = new ProjectStore(openDb(mkdtempSync(join(tmpdir(), "pupitre-mcpsel-"))));
});

test("un projet neuf ne filtre rien : comportement natif du CLI", () => {
  const project = projects.create({ name: "p", path: "/tmp/p" });
  expect(project.mcp_servers).toBeNull();
});

test("la sélection persiste, y compris vide", () => {
  const project = projects.create({ name: "p", path: "/tmp/p" });
  projects.setMcpServers(project.id, ["figma"]);
  expect(projects.get(project.id)?.mcp_servers).toEqual(["figma"]);
  // Liste vide = filtrage strict sans aucun serveur, distinct de « pas de filtre ».
  projects.setMcpServers(project.id, []);
  expect(projects.get(project.id)?.mcp_servers).toEqual([]);
  projects.setMcpServers(project.id, null);
  expect(projects.get(project.id)?.mcp_servers).toBeNull();
});

test("les définitions du projet écrasent celles du global", () => {
  const home = mkdtempSync(join(tmpdir(), "pupitre-mcphome-"));
  const project = mkdtempSync(join(tmpdir(), "pupitre-mcpproj-"));
  writeFileSync(join(home, ".claude.json"), JSON.stringify({
    mcpServers: { figma: { command: "global" }, tavily: { command: "npx" } },
    projects: { [project]: { mcpServers: { figma: { command: "projet" } } } },
  }));
  const definitions = claudeServerDefinitions(project, home);
  expect(definitions.figma).toEqual({ command: "projet" });
  expect(definitions.tavily).toEqual({ command: "npx" });
});

test("la config CLI ne contient que le bridge et les serveurs retenus", () => {
  const config = JSON.parse(claudeMcpConfigArg(
    { port: 4321, conversationId: "c1" },
    { figma: { command: "npx", args: ["figma-mcp"] } },
  ));
  expect(Object.keys(config.mcpServers).sort()).toEqual(["conductor", "figma"]);
});

test("sans conducteur, la config ne porte que les serveurs du projet", () => {
  const config = JSON.parse(claudeMcpConfigArg(null, { figma: { command: "npx" } }));
  expect(Object.keys(config.mcpServers)).toEqual(["figma"]);
});
