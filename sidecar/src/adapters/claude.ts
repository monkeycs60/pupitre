import { parseClaudeLine } from "./claude-parser";
import { spawnJsonl } from "./spawn-jsonl";
import type { TurnOptions, EmitFn } from "./types";

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
