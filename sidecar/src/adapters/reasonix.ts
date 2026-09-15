import { aiRoots } from "../access";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseReasonixLine } from "./reasonix-parser";
import { spawnJsonl } from "./spawn-jsonl";
import type { EmitFn, TurnOptions } from "./types";

export function runReasonixTurn(opts: TurnOptions, emit: EmitFn): Promise<void> {
  const bin = process.env.PUPITRE_REASONIX_BIN ?? "reasonix";
  const prompt = opts.images.length
    ? `${opts.prompt}\n\n[Images jointes: ${opts.images.join(", ")}]`
    : opts.prompt;
  const args = ["-p", "--output-format", "stream-json", "--model", opts.model];
  if (opts.effort) args.push("--effort", opts.effort);
  args.push("--permission-mode", opts.permissionMode);
  if (opts.cliSessionId) args.push("--resume", opts.cliSessionId);
  if (opts.filesystemScope === "full-system") args.push("--add-dir", "/");
  else for (const root of [...new Set([...(opts.extraWorkspaceRoots ?? []), ...aiRoots(), join(homedir(), ".reasonix")])]) args.push("--add-dir", root);
  args.push("--", prompt);
  return spawnJsonl({ bin, args, cwd: opts.cwd, parseLine: parseReasonixLine, emit, signal: opts.signal });
}
