import { fileURLToPath } from "node:url";

/**
 * Câblage du bridge MCP « conductor » côté CLI.
 *
 * Le bridge (`conductor-mcp.ts`) est un serveur MCP stdio SANS état : tout ce
 * qu'il sait, il le demande au sidecar en HTTP local. Il est donc lancé par le
 * CLI lui-même (un process par tour orchestrateur), et sa seule configuration
 * passe par deux variables d'environnement :
 * - `PUPITRE_PORT`            : le port HTTP du sidecar ;
 * - `PUPITRE_CONVERSATION_ID` : la conversation orchestratrice, c'est-à-dire le
 *   parent auquel rattacher les sous-tâches créées.
 */
export interface ConductorTarget {
  port: number;
  conversationId: string;
}

/** Chemin absolu du bridge, résolu depuis CE module (robuste au cwd du CLI). */
export function conductorMcpPath(): string {
  return fileURLToPath(new URL("./conductor-mcp.ts", import.meta.url));
}

export interface ConductorServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Description du serveur MCP, commune aux deux providers. */
export function conductorServerConfig(
  target: ConductorTarget,
  executable = process.execPath,
): ConductorServerConfig {
  const executableName = executable.split(/[\\/]/).at(-1)?.toLowerCase();
  const runsFromBun = executableName === "bun" || executableName === "bun.exe";
  return {
    command: executable,
    args: runsFromBun ? [conductorMcpPath()] : ["--conductor-mcp"],
    env: {
      PUPITRE_PORT: String(target.port),
      PUPITRE_CONVERSATION_ID: target.conversationId,
    },
  };
}

/** Valeur de `claude --mcp-config` : un JSON inline `{mcpServers:{…}}`. */
export function claudeMcpConfigArg(target: ConductorTarget): string {
  return JSON.stringify({ mcpServers: { conductor: conductorServerConfig(target) } });
}

/**
 * Bloc `config` de `thread/start` / `thread/resume` pour l'app-server codex :
 * les clés sont celles de `~/.codex/config.toml` (`mcp_servers.<nom>`), et le
 * champ est un override de config PAR THREAD — c'est ce qui permet de donner à
 * chaque tour son propre `PUPITRE_CONVERSATION_ID` malgré le process
 * app-server partagé par tout le sidecar.
 */
export function codexMcpConfig(target: ConductorTarget): Record<string, unknown> {
  return {
    mcp_servers: {
      conductor: { ...conductorServerConfig(target), enabled: true },
    },
  };
}

/** Équivalent pour `codex exec` (chemin historique) : des overrides `-c` TOML. */
export function codexExecConfigArgs(target: ConductorTarget): string[] {
  const server = conductorServerConfig(target);
  const toml = [
    `command=${JSON.stringify(server.command)}`,
    `args=[${server.args.map((arg) => JSON.stringify(arg)).join(", ")}]`,
    `env={${Object.entries(server.env)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(", ")}}`,
  ];
  return toml.flatMap((entry) => ["-c", `mcp_servers.conductor.${entry}`]);
}
