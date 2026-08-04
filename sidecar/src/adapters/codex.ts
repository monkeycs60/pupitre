import { parseCodexLine } from "./codex-parser";
import { spawnJsonl } from "./spawn-jsonl";
import type { TurnOptions, EmitFn } from "./types";

export function runCodexTurn(opts: TurnOptions, emit: EmitFn): Promise<void> {
  const bin = process.env.PUPITRE_CODEX_BIN ?? "codex";
  const base = opts.cliSessionId
    ? ["exec", "resume", opts.cliSessionId]
    : ["exec"];
  const args = [
    ...base,
    "--json", "--skip-git-repo-check", "-C", opts.cwd, "-m", opts.model,
    "-s", "workspace-write",
    ...opts.images.flatMap((image) => ["-i", image]),
    "--", opts.prompt,
  ];

  return spawnJsonl({
    bin,
    args,
    cwd: opts.cwd,
    parseLine: parseCodexLine,
    emit,
    signal: opts.signal,
  });
}
