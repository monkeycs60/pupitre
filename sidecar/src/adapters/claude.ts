import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { parseClaudeLine } from "./claude-parser";
import type { TurnOptions, EmitFn } from "./types";

export function runClaudeTurn(opts: TurnOptions, emit: EmitFn): Promise<void> {
  return new Promise((resolve) => {
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
    if (opts.cliSessionId) args.push("-r", opts.cliSessionId);
    args.push(prompt);

    emit({ type: "status", state: "running" });
    const child = spawn(bin, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let sawTerminal = false;

    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      for (const event of parseClaudeLine(line)) {
        if (event.type === "status") sawTerminal = true;
        emit(event);
      }
    });

    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      emit({ type: "status", state: "error", error: String(err) });
      resolve();
    });
    child.on("close", (code) => {
      if (!sawTerminal) {
        emit(code === 0
          ? { type: "status", state: "done" }
          : { type: "status", state: "error", error: stderr.slice(-2000) || `exit ${code}` });
      }
      resolve();
    });
  });
}
