import { appendFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { format } from "node:util";

export const PROCESS_LOG_MAX_BYTES = 5 * 1024 * 1024;

const LEVELS = ["log", "info", "warn", "error"] as const;
type ConsoleLike = Pick<Console, (typeof LEVELS)[number]>;

export function processLogPath(dataDir: string): string {
  return join(dataDir, "sidecar.log");
}

function rotateIfLarge(path: string, maxBytes: number): void {
  try {
    if (statSync(path).size > maxBytes) renameSync(path, `${path}.1`);
  } catch {
    // Pas encore de journal.
  }
}

/**
 * Double chaque ligne de la console dans un journal en ajout, propre à
 * l'instance : aucune redirection shell (`>`) ne peut plus effacer la trace
 * de l'arrêt précédent.
 */
export function installProcessLog(
  path: string,
  target: ConsoleLike = console,
  options: { maxBytes?: number; now?: () => Date; pid?: number } = {},
): void {
  const maxBytes = options.maxBytes ?? PROCESS_LOG_MAX_BYTES;
  const now = options.now ?? (() => new Date());
  rotateIfLarge(path, maxBytes);
  let writes = 0;
  const append = (line: string) => {
    try {
      if (++writes % 500 === 0) rotateIfLarge(path, maxBytes);
      appendFileSync(path, `[${now().toISOString()}] ${line}\n`);
    } catch {
      // Un disque plein ne doit pas faire tomber le sidecar.
    }
  };
  append(`démarrage du sidecar (pid ${options.pid ?? process.pid})`);
  for (const level of LEVELS) {
    const original = target[level].bind(target);
    target[level] = (...args: unknown[]) => {
      original(...args);
      append(`${level === "warn" || level === "error" ? `${level.toUpperCase()} ` : ""}${format(...args)}`);
    };
  }
}
