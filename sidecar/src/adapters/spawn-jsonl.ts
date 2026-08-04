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
  signal?: AbortSignal;
}

export function spawnJsonl(opts: SpawnJsonlOptions): Promise<void> {
  return new Promise((resolve) => {
    opts.emit({ type: "status", state: "running" });
    if (opts.signal?.aborted) {
      opts.emit({ type: "status", state: "error", error: "annulé" });
      resolve();
      return;
    }

    const child = spawn(opts.bin, opts.args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let sawTerminal = false;
    let settled = false;
    let aborted = false;

    const settle = () => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener("abort", abort);
      resolve();
    };

    const abort = () => {
      if (settled) return;
      aborted = true;
      sawTerminal = true;
      opts.emit({ type: "status", state: "error", error: "annulé" });
      if (!child.kill()) settle();
    };
    opts.signal?.addEventListener("abort", abort, { once: true });

    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (aborted) return;
      let events: AppEvent[];
      try {
        events = opts.parseLine(line);
      } catch (error) {
        console.error("Impossible de parser une ligne JSONL, ligne ignorée", error);
        return;
      }
      for (const event of events) {
        if (event.type === "status") sawTerminal = true;
        opts.emit(event);
      }
    });

    let stderr = "";
    child.stderr.on("data", (data) => (stderr += data));
    child.on("error", (error) => {
      if (!sawTerminal) {
        sawTerminal = true;
        opts.emit({ type: "status", state: "error", error: String(error) });
      }
      settle();
    });
    child.on("close", (code) => {
      if (!sawTerminal) {
        opts.emit(code === 0
          ? { type: "status", state: "done" }
          : { type: "status", state: "error", error: stderr.slice(-2000) || `exit ${code}` });
      }
      settle();
    });
  });
}
