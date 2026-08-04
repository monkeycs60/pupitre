import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { AppEvent } from "../events";
import type { EmitFn } from "./types";

interface SpawnJsonlOptions {
  bin: string;
  args: string[];
  cwd: string;
  parseLine: (line: string) => AppEvent[];
  emit: EmitFn;
}

export function spawnJsonl(opts: SpawnJsonlOptions): Promise<void> {
  return new Promise((resolve) => {
    opts.emit({ type: "status", state: "running" });
    const child = spawn(opts.bin, opts.args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let sawTerminal = false;

    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      for (const event of opts.parseLine(line)) {
        if (event.type === "status") sawTerminal = true;
        opts.emit(event);
      }
    });

    let stderr = "";
    child.stderr.on("data", (data) => (stderr += data));
    child.on("error", (error) => {
      sawTerminal = true;
      opts.emit({ type: "status", state: "error", error: String(error) });
      resolve();
    });
    child.on("close", (code) => {
      if (!sawTerminal) {
        opts.emit(code === 0
          ? { type: "status", state: "done" }
          : { type: "status", state: "error", error: stderr.slice(-2000) || `exit ${code}` });
      }
      resolve();
    });
  });
}
