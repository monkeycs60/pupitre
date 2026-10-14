import { appendFileSync, closeSync, openSync, readSync, renameSync, statSync } from "node:fs";
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

export type LifecycleKind = "start" | "stop" | "crash" | "rejection" | "unexplained";

export interface LifecycleEntry {
  at: string;
  kind: LifecycleKind;
  detail: string;
}

const LIFECYCLE_PATTERNS: Array<[LifecycleKind, RegExp]> = [
  ["stop", /^ERROR (?:\[[^\]]+\] )?arrêt du sidecar : (.*)/],
  ["crash", /^ERROR (?:\[[^\]]+\] )?exception non rattrapée, arrêt du sidecar :\s*(.*)/],
  ["rejection", /^ERROR (?:\[[^\]]+\] )?promesse rejetée sans gestionnaire, le sidecar continue :\s*(.*)/],
];

/** Démarrages, arrêts et erreurs fatales les plus récents, du plus récent au plus ancien. */
export function readLifecycle(path: string, limit = 10, tailBytes = 512 * 1024): LifecycleEntry[] {
  let text: string;
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - tailBytes);
    const buffer = Buffer.alloc(size - start);
    const fd = openSync(path, "r");
    try {
      readSync(fd, buffer, 0, buffer.length, start);
    } finally {
      closeSync(fd);
    }
    text = buffer.toString("utf8");
  } catch {
    return [];
  }
  const entries: LifecycleEntry[] = [];
  let pid = "";
  for (const line of text.split("\n")) {
    const stamped = /^\[(\d{4}-\d\d-\d\dT[^\]]+)\] (.*)$/.exec(line);
    if (!stamped) continue;
    const message = stamped[2]!;
    const booting = /^démarrage du sidecar \((.*)\)/.exec(message);
    if (booting) {
      pid = booting[1]!;
      continue;
    }
    // « prêt » s'écrit après l'éviction de l'instance précédente, dont
    // l'arrêt suit donc la ligne « démarrage » du nouveau process.
    if (/^pupitre sidecar prêt sur /.test(message)) {
      if (entries.findLast((entry) => entry.kind !== "rejection")?.kind === "start") {
        entries.push({ at: stamped[1]!, kind: "unexplained", detail: "arrêt sans trace avant ce démarrage" });
      }
      entries.push({ at: stamped[1]!, kind: "start", detail: pid });
      pid = "";
      continue;
    }
    for (const [kind, pattern] of LIFECYCLE_PATTERNS) {
      const match = pattern.exec(message);
      if (match) {
        entries.push({ at: stamped[1]!, kind, detail: (match[1] ?? "").trim() });
        break;
      }
    }
  }
  return entries.slice(-limit).reverse();
}
