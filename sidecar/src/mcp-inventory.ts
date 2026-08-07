import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Inventaire des serveurs MCP que l'UTILISATEUR a configurés — ceux que Pupitre
 * n'injecte pas et dont il ne connaît donc pas le coût. Les nommer rend
 * l'alerte de contexte actionnable : sans ça, « désactivez un serveur MCP »
 * laisse chercher lequel.
 *
 * On ne lit QUE les noms : les fichiers de configuration contiennent des clés
 * d'API en clair, qui ne doivent jamais traverser l'API du sidecar.
 */
export interface McpServerRef {
  name: string;
  provider: "claude" | "codex";
  scope: "global" | "projet";
}

function readJson(path: string): Record<string, any> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
  } catch {
    // Fichier absent ou illisible : l'inventaire est une commodité, pas un dû.
    return null;
  }
}

function names(value: unknown): string[] {
  return value && typeof value === "object" ? Object.keys(value as object) : [];
}

/** Sections `[mcp_servers.NOM]` d'un config.toml, sous-tables exclues. */
function tomlServerNames(path: string): string[] {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const found = new Set<string>();
  for (const match of content.matchAll(/^\s*\[mcp_servers\.([^.\]]+)\]/gmu)) {
    const name = match[1]?.trim();
    if (name) found.add(name);
  }
  return [...found];
}

/**
 * Définitions COMPLÈTES des serveurs Claude (commande, arguments, variables
 * d'environnement). Réservé au sidecar : ces objets contiennent des clés d'API
 * en clair et ne doivent jamais transiter par l'API HTTP. Sert uniquement à
 * réinjecter les serveurs retenus quand un projet filtre sa liste.
 */
export function claudeServerDefinitions(
  projectPath: string,
  home = homedir(),
): Record<string, unknown> {
  const claudeConfig = readJson(join(home, ".claude.json"));
  return {
    ...(claudeConfig?.mcpServers ?? {}),
    ...(readJson(join(projectPath, ".mcp.json"))?.mcpServers ?? {}),
    // Le scope projet gagne sur le global : c'est l'ordre de résolution du CLI.
    ...(claudeConfig?.projects?.[projectPath]?.mcpServers ?? {}),
  };
}

export function listMcpServers(projectPath: string, home = homedir()): McpServerRef[] {
  const servers: McpServerRef[] = [];
  const claudeConfig = readJson(join(home, ".claude.json"));
  for (const name of names(claudeConfig?.mcpServers)) {
    servers.push({ name, provider: "claude", scope: "global" });
  }
  for (const name of names(claudeConfig?.projects?.[projectPath]?.mcpServers)) {
    servers.push({ name, provider: "claude", scope: "projet" });
  }
  for (const name of names(readJson(join(projectPath, ".mcp.json"))?.mcpServers)) {
    servers.push({ name, provider: "claude", scope: "projet" });
  }
  for (const name of tomlServerNames(join(home, ".codex", "config.toml"))) {
    servers.push({ name, provider: "codex", scope: "global" });
  }
  // Un même serveur peut être déclaré deux fois (global + projet) : il n'est
  // chargé qu'une fois, on ne le compte donc qu'une fois.
  const seen = new Set<string>();
  return servers.filter((server) => {
    const key = `${server.provider}:${server.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
