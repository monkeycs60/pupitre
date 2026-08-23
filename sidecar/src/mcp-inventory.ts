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
  provider: "claude" | "codex" | "grok";
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

/** Valeur TOML scalaire ou tableau de chaînes, suffisant pour nos champs. */
function tomlValue(raw: string): string | string[] | null {
  const value = raw.trim();
  if (value.startsWith("[")) {
    return [...value.matchAll(/"((?:[^"\\]|\\.)*)"/gu)].map((match) => match[1] ?? "");
  }
  const quoted = value.match(/^"((?:[^"\\]|\\.)*)"$/u);
  return quoted ? quoted[1] ?? "" : null;
}

/**
 * Définitions Codex, extraites de config.toml. Réservé au sidecar : les blocs
 * `env` contiennent des clés d'API. Parseur volontairement minimal — on ne lit
 * que `command`, `args` et `env`, seuls champs nécessaires pour lancer le
 * serveur et le peser.
 */
export function codexServerDefinitions(home = homedir()): Record<string, unknown> {
  let content: string;
  try {
    content = readFileSync(join(home, ".codex", "config.toml"), "utf8");
  } catch {
    return {};
  }
  const servers: Record<string, any> = {};
  let current: string | null = null;
  let inEnv = false;
  for (const line of content.split("\n")) {
    const section = line.match(/^\s*\[mcp_servers\.([^.\]]+)(\.[^\]]+)?\]/u);
    if (section) {
      const name = section[1]!;
      const sub = section[2];
      // Une sous-table autre que `.env` (par ex. `.tools.xxx`) est ignorée.
      inEnv = sub === ".env";
      current = sub === undefined || inEnv ? name : null;
      if (current && !servers[current]) servers[current] = { command: "", args: [], env: {} };
      continue;
    }
    if (/^\s*\[/u.test(line)) {
      current = null;
      inEnv = false;
      continue;
    }
    if (!current) continue;
    const pair = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/u);
    if (!pair) continue;
    const [, key, rawValue] = pair;
    const value = tomlValue(rawValue!);
    if (value === null) continue;
    if (inEnv) servers[current].env[key!] = String(value);
    else if (key === "command" && typeof value === "string") servers[current].command = value;
    else if (key === "args" && Array.isArray(value)) servers[current].args = value;
  }
  // Un serveur sans commande n'est pas lançable : le peser n'a pas de sens.
  return Object.fromEntries(
    Object.entries(servers).filter(([, server]) => server.command),
  );
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

/**
 * Serveurs MCP réellement appelés dans un projet, d'après les noms d'outils des
 * événements `tool-start`. Les deux CLI préfixent les outils MCP de la même
 * façon : `mcp__<serveur>__<outil>`.
 */
/**
 * Serveurs à peser : présents dans la sélection, lançables, et pas encore en
 * cache. Un nom hors définitions (URL Codex sans commande, plugin) ne doit
 * PAS relancer la sonde de tous les autres — c'était le leak ClickUp.
 */
export function unmeasuredMcpServers(
  loaded: string[],
  available: Record<string, unknown>,
  weights: Record<string, { tokens: number | null }>,
): Record<string, unknown> {
  return Object.fromEntries(
    loaded.flatMap((name) => {
      if (!(name in available) || weights[name] !== undefined) return [];
      return [[name, available[name]]];
    }),
  );
}

export function usedMcpServers(toolNames: string[]): string[] {
  const used = new Set<string>();
  for (const toolName of toolNames) {
    const match = toolName.match(/^mcp__([^_]+(?:_[^_]+)*?)__/u);
    if (match?.[1]) used.add(match[1]);
  }
  return [...used];
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
  for (const name of tomlServerNames(join(home, ".grok", "config.toml"))) {
    servers.push({ name, provider: "grok", scope: "global" });
  }
  for (const name of tomlServerNames(join(projectPath, ".grok", "config.toml"))) {
    servers.push({ name, provider: "grok", scope: "projet" });
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
