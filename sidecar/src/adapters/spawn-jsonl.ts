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
  env?: Record<string, string>;
  /** Garde stdin ouvert afin qu'un provider accepte des messages en vol. */
  streamingInput?: {
    initialLine: string;
    registerWrite: (writeLine: (line: string) => Promise<boolean>) => void;
  };
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
      stdio: [opts.streamingInput ? "pipe" : "ignore", "pipe", "pipe"],
      env: opts.env ? { ...process.env, ...opts.env } : undefined,
      // Les serveurs MCP du provider sont ses enfants : un signal envoyé au
      // seul pid du provider les laisse vivants, simplement reparentés. Le
      // groupe dédié les rend joignables par `process.kill(-pid)`.
      detached: true,
    });
    let sawTerminal = false;
    let settled = false;
    let aborted = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const stdin = child.stdin;
    if (opts.streamingInput && stdin) {
      // Les writes Node sont ordonnés : le premier prompt sera toujours reçu
      // avant une éventuelle précision envoyée immédiatement après le spawn.
      stdin.write(opts.streamingInput.initialLine + "\n");
      opts.streamingInput.registerWrite((line) => new Promise((resolve) => {
        if (settled || sawTerminal || stdin.destroyed) {
          resolve(false);
          return;
        }
        stdin.write(line + "\n", (error) => resolve(error == null));
      }));
      // Une fermeture précoce du process peut aussi faire échouer stdin ;
      // l'événement `error` du child publiera le statut terminal.
      stdin.on("error", () => {});
    }

    const settle = () => {
      if (settled) return;
      settled = true;
      if (killTimer !== undefined) clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", abort);
      resolve();
    };

    // Un pid négatif vise le groupe entier. Le groupe survit au provider
    // lui-même tant qu'un serveur MCP y tourne, donc l'échec du signal de
    // groupe est le seul indice fiable qu'il ne reste rien à tuer.
    const signalTree = (signal: NodeJS.Signals): boolean => {
      if (child.pid === undefined) return false;
      try {
        process.kill(-child.pid, signal);
        return true;
      } catch {
        return child.kill(signal);
      }
    };

    const abort = () => {
      if (settled) return;
      aborted = true;
      sawTerminal = true;
      opts.emit({ type: "status", state: "error", error: "annulé" });
      if (!signalTree("SIGTERM")) {
        settle();
        return;
      }
      killTimer = setTimeout(() => {
        if (!settled) signalTree("SIGKILL");
      }, 3_000);
      killTimer.unref();
    };
    opts.signal?.addEventListener("abort", abort, { once: true });

    const stdout = child.stdout;
    const stderrStream = child.stderr;
    if (!stdout || !stderrStream) throw new Error("stdout/stderr indisponible");
    const lines = createInterface({ input: stdout });
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
        if (event.type === "status") {
          sawTerminal = true;
          child.stdin?.end();
        }
        opts.emit(event);
      }
    });

    let stderr = "";
    stderrStream.on("data", (data) => (stderr += data));
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
