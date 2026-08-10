import { fileURLToPath } from "node:url";

export interface PupitreTarget {
  port: number;
  conversationId: string;
}

export interface PupitreServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export function pupitreMcpPath(): string {
  return fileURLToPath(new URL("./pupitre-mcp.ts", import.meta.url));
}

export function pupitreServerConfig(
  target: PupitreTarget,
  executable = process.execPath,
): PupitreServerConfig {
  const executableName = executable.split(/[\\/]/).at(-1)?.toLowerCase();
  const runsFromBun = executableName === "bun" || executableName === "bun.exe";
  return {
    command: executable,
    args: runsFromBun ? [pupitreMcpPath()] : ["--pupitre-mcp"],
    env: {
      PUPITRE_PORT: String(target.port),
      PUPITRE_CONVERSATION_ID: target.conversationId,
    },
  };
}

export function codexPupitreMcpServer(target: PupitreTarget): Record<string, unknown> {
  return { ...pupitreServerConfig(target), enabled: true };
}

export function codexExecPupitreConfigArgs(target: PupitreTarget): string[] {
  const server = pupitreServerConfig(target);
  const toml = [
    `command=${JSON.stringify(server.command)}`,
    `args=[${server.args.map((arg) => JSON.stringify(arg)).join(", ")}]`,
    `env={${Object.entries(server.env)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(", ")}}`,
  ];
  return toml.flatMap((entry) => ["-c", `mcp_servers.pupitre.${entry}`]);
}
