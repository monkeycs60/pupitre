import { parseClaudeLine } from "./claude-parser";
import { spawnJsonl } from "./spawn-jsonl";
import type { TurnOptions, EmitFn } from "./types";
import { claudeMcpConfigArg } from "../conductor";

export function runClaudeTurn(opts: TurnOptions, emit: EmitFn): Promise<void> {
  const bin = process.env.PUPITRE_CLAUDE_BIN ?? "claude";
  // M1 : les images utilisateur sont référencées par chemin dans le prompt.
  // (Claude Code lit les fichiers image du disque via son outil Read.)
  const prompt = opts.images.length
    ? `${opts.prompt}\n\n[Images jointes: ${opts.images.join(", ")}]`
    : opts.prompt;
  const args = [
    "-p", "--output-format", "stream-json", "--include-partial-messages",
    "--verbose", "--model", opts.model, "--permission-mode", opts.permissionMode,
  ];
  if (opts.effort) args.push("--effort", opts.effort);
  // `--mcp-config` accepte un chemin de fichier OU un JSON inline (cf.
  // `claude --help`) ; pas de `--strict-mcp-config` : les serveurs MCP que
  // l'utilisateur a configurés lui-même restent disponibles.
  if (opts.conductor) args.push("--mcp-config", claudeMcpConfigArg(opts.conductor));
  if (opts.cliSessionId) args.push("-r", opts.cliSessionId);
  args.push("--", prompt);

  return spawnJsonl({
    bin,
    args,
    cwd: opts.cwd,
    parseLine: parseClaudeLine,
    emit,
    signal: opts.signal,
  });
}
