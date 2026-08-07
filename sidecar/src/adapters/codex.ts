import { parseCodexLine } from "./codex-parser";
import { spawnJsonl } from "./spawn-jsonl";
import type { TurnOptions, EmitFn } from "./types";
import { codexExecConfigArgs } from "../conductor";
import { aiRoots, DEFAULT_FILESYSTEM_SCOPE } from "../access";

export function runCodexTurn(opts: TurnOptions, emit: EmitFn): Promise<void> {
  const bin = process.env.PUPITRE_CODEX_BIN ?? "codex";
  const base = opts.cliSessionId
    ? ["exec", "resume", opts.cliSessionId]
    : ["exec"];
  // Le subcommand `resume` n'accepte ni -C ni -s (vérifié codex-cli 0.144.5) :
  // le cwd passe par le spawn, et le sandbox par -c sandbox_mode sur un resume.
  const scope = opts.filesystemScope ?? DEFAULT_FILESYSTEM_SCOPE;
  // `exec resume` n'accepte pas --add-dir sur codex-cli 0.144.5. On conserve
  // l'accès aux racines IA sur ce chemin historique en élargissant le sandbox.
  const sandboxMode = opts.sandboxMode ?? (
    scope === "full-system" || opts.cliSessionId ? "danger-full-access" : "workspace-write"
  );
  const sandbox = opts.cliSessionId
    ? ["-c", `sandbox_mode=${JSON.stringify(sandboxMode)}`]
    : ["-s", sandboxMode];
  const args = [
    ...base,
    "--json", "--skip-git-repo-check", "-m", opts.model,
    ...sandbox,
    ...(opts.effort ? ["-c", `model_reasoning_effort="${opts.effort}"`] : []),
    ...(opts.speed === "fast"
      ? ["--enable", "fast_mode", "-c", 'service_tier="fast"']
      : []),
    ...(opts.conductor ? codexExecConfigArgs(opts.conductor) : []),
    ...(opts.cliSessionId || scope === "full-system" || opts.sandboxMode
      ? []
      : ["--add-dir", ...aiRoots()]),
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
